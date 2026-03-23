package handlers

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/alexedwards/scs/v2"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"kcal-counter/internal/httpapi/jsonio"
	"kcal-counter/internal/kcal"
)

type kcalService interface {
	CreateEntry(context.Context, int64, kcal.EntryInput) (kcal.Entry, error)
	CreateTemplateItem(context.Context, int64, kcal.TemplateItemInput) (kcal.TemplateItem, error)
	DeleteEntry(context.Context, int64, uuid.UUID) error
	DeleteTemplateItem(context.Context, int64, uuid.UUID) error
	GetTotalInRange(context.Context, int64, time.Time, time.Time) (int64, error)
	ListEntriesInRange(context.Context, int64, time.Time, time.Time) ([]kcal.Entry, error)
	ListTemplateItems(context.Context, int64, string) ([]kcal.TemplateItem, error)
	Sync(context.Context, int64, kcal.SyncInput) (kcal.SyncResult, error)
	UpdateEntry(context.Context, int64, uuid.UUID, kcal.EntryInput) (kcal.Entry, error)
	UpdateTemplateItem(context.Context, int64, uuid.UUID, kcal.TemplateItemInput) (kcal.TemplateItem, error)
}

type KcalHandler struct {
	Service  kcalService
	Sessions *scs.SessionManager
}

func (h KcalHandler) ListTemplates(w http.ResponseWriter, r *http.Request) {
	items, err := h.Service.ListTemplateItems(r.Context(), h.userID(r), chi.URLParam(r, "kind"))
	if err != nil {
		handleKcalError(w, err)
		return
	}

	jsonio.WriteJSON(w, http.StatusOK, map[string]any{"templates": items})
}

func (h KcalHandler) CreateTemplate(w http.ResponseWriter, r *http.Request) {
	var req templateItemRequest
	if err := jsonio.DecodeAndValidate(w, r, &req); err != nil {
		return
	}

	item, err := h.Service.CreateTemplateItem(r.Context(), h.userID(r), req.toInput(nil))
	if err != nil {
		handleKcalError(w, err)
		return
	}

	jsonio.WriteJSON(w, http.StatusCreated, map[string]any{"template": item})
}

func (h KcalHandler) UpdateTemplate(w http.ResponseWriter, r *http.Request) {
	itemID, err := parsePathUUID(chi.URLParam(r, "id"), "template id")
	if err != nil {
		jsonio.WriteError(w, http.StatusBadRequest, "invalid_path", err.Error())
		return
	}

	var req templateItemRequest
	if err := jsonio.DecodeAndValidate(w, r, &req); err != nil {
		return
	}

	item, err := h.Service.UpdateTemplateItem(r.Context(), h.userID(r), itemID, req.toInput(nil))
	if err != nil {
		handleKcalError(w, err)
		return
	}

	jsonio.WriteJSON(w, http.StatusOK, map[string]any{"template": item})
}

func (h KcalHandler) DeleteTemplate(w http.ResponseWriter, r *http.Request) {
	itemID, err := parsePathUUID(chi.URLParam(r, "id"), "template id")
	if err != nil {
		jsonio.WriteError(w, http.StatusBadRequest, "invalid_path", err.Error())
		return
	}

	if err := h.Service.DeleteTemplateItem(r.Context(), h.userID(r), itemID); err != nil {
		handleKcalError(w, err)
		return
	}

	jsonio.WriteJSON(w, http.StatusOK, map[string]any{"deleted": true})
}

func (h KcalHandler) ListEntries(w http.ResponseWriter, r *http.Request) {
	from, to, err := parseRangeQuery(r)
	if err != nil {
		jsonio.WriteError(w, http.StatusBadRequest, "invalid_query", err.Error())
		return
	}

	entries, err := h.Service.ListEntriesInRange(r.Context(), h.userID(r), from, to)
	if err != nil {
		handleKcalError(w, err)
		return
	}

	jsonio.WriteJSON(w, http.StatusOK, map[string]any{"entries": entries})
}

func (h KcalHandler) CreateEntry(w http.ResponseWriter, r *http.Request) {
	var req entryRequest
	if err := jsonio.DecodeAndValidate(w, r, &req); err != nil {
		return
	}

	entry, err := h.Service.CreateEntry(r.Context(), h.userID(r), req.toInput(nil))
	if err != nil {
		handleKcalError(w, err)
		return
	}

	jsonio.WriteJSON(w, http.StatusCreated, map[string]any{"entry": entry})
}

func (h KcalHandler) UpdateEntry(w http.ResponseWriter, r *http.Request) {
	entryID, err := parsePathUUID(chi.URLParam(r, "id"), "entry id")
	if err != nil {
		jsonio.WriteError(w, http.StatusBadRequest, "invalid_path", err.Error())
		return
	}

	var req entryRequest
	if err := jsonio.DecodeAndValidate(w, r, &req); err != nil {
		return
	}

	entry, err := h.Service.UpdateEntry(r.Context(), h.userID(r), entryID, req.toInput(nil))
	if err != nil {
		handleKcalError(w, err)
		return
	}

	jsonio.WriteJSON(w, http.StatusOK, map[string]any{"entry": entry})
}

func (h KcalHandler) DeleteEntry(w http.ResponseWriter, r *http.Request) {
	entryID, err := parsePathUUID(chi.URLParam(r, "id"), "entry id")
	if err != nil {
		jsonio.WriteError(w, http.StatusBadRequest, "invalid_path", err.Error())
		return
	}

	if err := h.Service.DeleteEntry(r.Context(), h.userID(r), entryID); err != nil {
		handleKcalError(w, err)
		return
	}

	jsonio.WriteJSON(w, http.StatusOK, map[string]any{"deleted": true})
}

func (h KcalHandler) Total(w http.ResponseWriter, r *http.Request) {
	from, to, err := parseRangeQuery(r)
	if err != nil {
		jsonio.WriteError(w, http.StatusBadRequest, "invalid_query", err.Error())
		return
	}

	total, err := h.Service.GetTotalInRange(r.Context(), h.userID(r), from, to)
	if err != nil {
		handleKcalError(w, err)
		return
	}

	jsonio.WriteJSON(w, http.StatusOK, map[string]any{"total_kcal": total})
}

func (h KcalHandler) Sync(w http.ResponseWriter, r *http.Request) {
	var req syncRequest
	if err := jsonio.DecodeAndValidate(w, r, &req); err != nil {
		return
	}

	deviceID, _ := uuid.Parse(req.DeviceID)
	input := kcal.SyncInput{
		DeviceID:        deviceID,
		LastSyncVersion: req.LastSyncVersion,
		Changes:         make([]kcal.SyncRecord, 0, len(req.Changes)),
	}
	for _, change := range req.Changes {
		changeID, _ := uuid.Parse(change.ID)
		input.Changes = append(input.Changes, kcal.SyncRecord{
			EntityTable:     change.EntityTable,
			ID:              changeID,
			Kind:            change.Kind,
			Name:            change.Name,
			Amount:          change.Amount,
			Unit:            change.Unit,
			KcalAmount:      change.KcalAmount,
			KcalDelta:       change.KcalDelta,
			HappenedAt:      change.HappenedAt,
			Deleted:         change.Deleted,
			ClientUpdatedAt: change.ClientUpdatedAt,
		})
	}

	result, err := h.Service.Sync(r.Context(), h.userID(r), input)
	if err != nil {
		handleKcalError(w, err)
		return
	}

	jsonio.WriteJSON(w, http.StatusOK, result)
}

func (h KcalHandler) userID(r *http.Request) int64 {
	return h.Sessions.GetInt64(r.Context(), "user_id")
}

func parseRangeQuery(r *http.Request) (time.Time, time.Time, error) {
	from, err := parseRFC3339Query("from", r.URL.Query().Get("from"))
	if err != nil {
		return time.Time{}, time.Time{}, err
	}
	to, err := parseRFC3339Query("to", r.URL.Query().Get("to"))
	if err != nil {
		return time.Time{}, time.Time{}, err
	}
	if !from.Before(to) {
		return time.Time{}, time.Time{}, errors.New("from must be before to")
	}
	return from.UTC(), to.UTC(), nil
}

func parseRFC3339Query(field, value string) (time.Time, error) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return time.Time{}, fmt.Errorf("%s is required", field)
	}
	parsed, err := time.Parse(time.RFC3339, trimmed)
	if err != nil {
		return time.Time{}, fmt.Errorf("%s must be RFC3339", field)
	}
	return parsed, nil
}

func parsePathUUID(value string, field string) (uuid.UUID, error) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return uuid.Nil, fmt.Errorf("%s is required", field)
	}
	parsed, err := uuid.Parse(trimmed)
	if err != nil {
		return uuid.Nil, fmt.Errorf("%s must be a UUID", field)
	}
	return parsed, nil
}

func handleKcalError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, sql.ErrNoRows):
		jsonio.WriteError(w, http.StatusNotFound, "not_found", "resource not found")
	case errors.Is(err, kcal.ErrInvalidTemplateKind):
		jsonio.WriteError(w, http.StatusBadRequest, "invalid_template_kind", err.Error())
	default:
		jsonio.WriteError(w, http.StatusInternalServerError, "internal_error", "an unexpected error occurred")
	}
}
