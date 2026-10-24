package handlers

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"kcal-counter/internal/kcal"
	"kcal-counter/internal/validation"
)

var templateAmountPattern = regexp.MustCompile(`^\+?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$`)

const (
	minTemplateAmount = 0.001
	maxTemplateAmount = 999999999.999
)

type templateItemRequest struct {
	Kind       string `json:"kind"`
	Name       string `json:"name"`
	Amount     string `json:"amount"`
	Unit       string `json:"unit"`
	KcalAmount int32  `json:"kcal_amount"`
}

type entryRequest struct {
	KcalDelta  int32     `json:"kcal_delta"`
	HappenedAt time.Time `json:"happened_at"`
}

type syncRequest struct {
	UserID          string              `json:"user_id"`
	DeviceID        string              `json:"device_id"`
	LastSyncVersion int64               `json:"last_sync_seq"`
	Changes         []syncChangeRequest `json:"changes"`
}

type syncChangeRequest struct {
	EffectiveFrom   string          `json:"effective_from"`
	KcalLimit       *int32          `json:"kcal_limit"`
	StartDate       string          `json:"start_date"`
	EndDate         string          `json:"end_date"`
	Items           []kcal.MealItem `json:"items"`
	EntityTable     string          `json:"entity_table"`
	ID              string          `json:"id"`
	Kind            string          `json:"kind"`
	Name            string          `json:"name"`
	Amount          string          `json:"amount"`
	Unit            string          `json:"unit"`
	KcalAmount      int32           `json:"kcal_amount"`
	KcalDelta       int32           `json:"kcal_delta"`
	HappenedAt      *time.Time      `json:"happened_at"`
	CycleStartDate  *string         `json:"cycle_start_date"`
	Deleted         bool            `json:"deleted"`
	ClientUpdatedAt time.Time       `json:"client_updated_at"`
}

func (r *syncRequest) Normalize() {
	r.DeviceID = strings.TrimSpace(r.DeviceID)
	for i := range r.Changes {
		r.Changes[i].Normalize()
	}
}

func (r syncRequest) Validate() error {
	err := validation.New()
	validateUUID(err, "device_id", r.DeviceID)
	if r.LastSyncVersion < 0 {
		err.Add("last_sync_seq", "between", 0, 9223372036854775807)
	}
	for i, change := range r.Changes {
		change.validate(err, i)
	}
	return err.ErrOrNil()
}

func (r *syncChangeRequest) Normalize() {
	r.EntityTable = strings.ToLower(strings.TrimSpace(r.EntityTable))
	r.ID = strings.TrimSpace(r.ID)
	r.Kind = strings.ToLower(strings.TrimSpace(r.Kind))
	r.Name = strings.TrimSpace(r.Name)
	r.Amount = strings.TrimSpace(r.Amount)
	r.Unit = strings.TrimSpace(r.Unit)
	r.ClientUpdatedAt = r.ClientUpdatedAt.UTC()
	if r.HappenedAt != nil {
		happenedAt := r.HappenedAt.UTC()
		r.HappenedAt = &happenedAt
	}
}

func (r syncChangeRequest) validate(err *validation.Errors, index int) {
	prefix := fmt.Sprintf("changes[%d]", index)
	validateUUID(err, prefix+".id", r.ID)
	if hasError := err.NotBlank(prefix+".entity_table", r.EntityTable); hasError {
		return
	}
	if r.ClientUpdatedAt.IsZero() {
		err.Add(prefix+".client_updated_at", "required")
	}

	switch r.EntityTable {
	case kcal.EntityTableTemplateItems:
		if hasError := err.NotBlank(prefix+".kind", r.Kind); !hasError {
			err.In(prefix+".kind", r.Kind, "food", "activity")
		}
		err.NotBlank(prefix+".name", r.Name)
		err.NotBlank(prefix+".unit", r.Unit)
		validateTemplateAmount(err, prefix+".amount", r.Amount)
		if r.KcalAmount <= 0 {
			err.Add(prefix+".kcal_amount", "between", 1, 2147483647)
		}
	case kcal.EntityTableEntries:
		if r.HappenedAt == nil || r.HappenedAt.IsZero() {
			err.Add(prefix+".happened_at", "required")
		}
		if r.KcalDelta == 0 {
			err.Add(prefix+".kcal_delta", "between", -2147483648, 2147483647)
		}
	case kcal.EntityTablePeriodStarts:
		if r.ID != kcal.PeriodStartID {
			err.Add(prefix+".id", "pattern", kcal.PeriodStartID)
		}
		if r.Deleted {
			err.Add(prefix+".deleted", "pattern", "false; use a null cycle_start_date to clear the date")
		}
		if _, parseErr := kcal.ParseCycleStartDate(r.CycleStartDate); parseErr != nil {
			err.Add(prefix+".cycle_start_date", "pattern", "YYYY-MM-DD")
		}
	case kcal.EntityTableTargets, kcal.EntityTablePeriods, kcal.EntityTableMeals:
		if trackingErr := kcal.ValidateTrackingChange(r.toSyncRecord()); trackingErr != nil {
			err.Add(prefix, "pattern", trackingErr.Error())
		}
	default:
		err.In(prefix+".entity_table", r.EntityTable, kcal.EntityTableTemplateItems, kcal.EntityTableEntries, kcal.EntityTablePeriodStarts, kcal.EntityTableTargets, kcal.EntityTablePeriods, kcal.EntityTableMeals)
	}
}

func validateUUID(err *validation.Errors, field, value string) {
	if hasError := err.NotBlank(field, value); hasError {
		return
	}
	if parsed, parseErr := uuid.Parse(value); parseErr != nil || parsed == uuid.Nil {
		err.Add(field, "pattern", "uuid")
	}
}

func (r *templateItemRequest) Normalize() {
	r.Kind = strings.ToLower(strings.TrimSpace(r.Kind))
	r.Name = strings.TrimSpace(r.Name)
	r.Amount = strings.TrimSpace(r.Amount)
	r.Unit = strings.TrimSpace(r.Unit)
}

func (r templateItemRequest) Validate() error {
	err := validation.New()
	if hasError := err.NotBlank("kind", r.Kind); !hasError {
		err.In("kind", r.Kind, "food", "activity")
	}
	err.NotBlank("name", r.Name)
	err.NotBlank("unit", r.Unit)
	validateTemplateAmount(err, "amount", r.Amount)
	if r.KcalAmount <= 0 {
		err.Add("kcal_amount", "between", 1, 2147483647)
	}
	return err.ErrOrNil()
}

func validateTemplateAmount(err *validation.Errors, field, amount string) {
	if err.NotBlank(field, amount) {
		return
	}
	if !templateAmountPattern.MatchString(amount) {
		err.Add(field, "pattern", "positive decimal")
		return
	}
	value, parseErr := strconv.ParseFloat(amount, 64)
	// Match the database's NUMERIC(12,3) range so invalid amounts cannot
	// turn an otherwise valid template or sync request into a database error.
	if parseErr != nil || value < minTemplateAmount || value > maxTemplateAmount {
		err.Add(field, "between", minTemplateAmount, maxTemplateAmount)
	}
}

func (r templateItemRequest) toInput(id *uuid.UUID) kcal.TemplateItemInput {
	return kcal.TemplateItemInput{
		ID:         id,
		Kind:       r.Kind,
		Name:       r.Name,
		Amount:     r.Amount,
		Unit:       r.Unit,
		KcalAmount: r.KcalAmount,
	}
}

func (r *entryRequest) Normalize() {
	r.HappenedAt = r.HappenedAt.UTC()
}

func (r entryRequest) Validate() error {
	err := validation.New()
	if r.KcalDelta == 0 {
		err.Add("kcal_delta", "between", -2147483648, 2147483647)
	}
	if r.HappenedAt.IsZero() {
		err.Add("happened_at", "required")
	}
	return err.ErrOrNil()
}

func (r entryRequest) toInput(id *uuid.UUID) kcal.EntryInput {
	return kcal.EntryInput{ID: id, KcalDelta: r.KcalDelta, HappenedAt: r.HappenedAt}
}

func (r syncChangeRequest) toSyncRecord() kcal.SyncRecord {
	id, _ := uuid.Parse(r.ID)
	return kcal.SyncRecord{
		EntityTable: r.EntityTable, ID: id, Kind: r.Kind, Name: r.Name, Amount: r.Amount, Unit: r.Unit,
		KcalAmount: r.KcalAmount, KcalDelta: r.KcalDelta, HappenedAt: r.HappenedAt,
		CycleStartDate: r.CycleStartDate, EffectiveFrom: r.EffectiveFrom, KcalLimit: r.KcalLimit,
		StartDate: r.StartDate, EndDate: r.EndDate, Items: r.Items,
		Deleted: r.Deleted, ClientUpdatedAt: r.ClientUpdatedAt,
	}
}
