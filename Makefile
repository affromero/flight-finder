.PHONY: setup dev build logs reset clean

setup: ## First-time setup: copy env and start all services
	@test -f .env || cp .env.example .env
	docker compose stop web
	docker compose up -d --no-recreate db redis
	docker compose run --rm --no-deps -e SIDEDOOR_PREPARE_ONLY=true web
	docker compose up -d
	@echo "Open http://localhost:3003 to complete setup"

dev: ## Start DB + Redis, run Next.js in dev mode
	docker compose up -d db redis
	npm install
	npm run db:push
	npm run db:generate
	npm run cli -- access initialize
	npm run dev

build: ## Build production image
	docker compose build web

logs: ## Follow web container logs
	docker compose logs -f web

reset: ## Reset database (destroys all data)
	docker compose down -v
	@echo "All data deleted. Run 'make setup' to start fresh."

clean: ## Remove all containers and images
	docker compose down -v --rmi local

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-12s\033[0m %s\n", $$1, $$2}'

.DEFAULT_GOAL := help
