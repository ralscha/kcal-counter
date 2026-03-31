package main

import (
	"context"
	"flag"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"kcal-counter/internal/app"
	"kcal-counter/internal/config"
)

func main() {
	configPath, err := parseArgs(os.Args[1:])
	if err != nil {
		slog.Error("parse args", slog.Any("err", err))
		os.Exit(2)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	if err := run(ctx, configPath); err != nil {
		stop()
		os.Exit(1)
	}
	stop()
}

func parseArgs(args []string) (string, error) {
	flags := flag.NewFlagSet("app", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)

	configPath := flags.String("config", "", "path to config YAML file")
	if err := flags.Parse(args); err != nil {
		return "", err
	}

	return *configPath, nil
}

func run(ctx context.Context, configPath string) error {
	cfg, err := config.Load(configPath)
	if err != nil {
		slog.Error("load config", slog.Any("err", err))
		return err
	}

	application, err := app.New(ctx, cfg)
	if err != nil {
		slog.Error("create app", slog.Any("err", err))
		return err
	}

	if err := application.Run(ctx); err != nil {
		application.Logger().Error("run app", slog.Any("err", err))
		return err
	}

	return nil
}
