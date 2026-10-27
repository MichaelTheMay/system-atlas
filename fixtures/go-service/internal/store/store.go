package store

import (
	"context"
	"database/sql"
)

// Order is one customer order.
type Order struct {
	ID    string
	Total int
}

// Store persists orders in Postgres.
type Store struct{ db *sql.DB }

const maxPage = 50

func New(db *sql.DB) *Store { return &Store{db: db} }

func (s *Store) Get(ctx context.Context, id string) (Order, error) {
	var o Order
	err := s.db.QueryRowContext(ctx, "SELECT id, total FROM orders WHERE id = $1", id).Scan(&o.ID, &o.Total)
	return o, err
}

func (s *Store) Create(ctx context.Context, o Order) error {
	_, err := s.db.ExecContext(ctx, "INSERT INTO orders (id, total) VALUES ($1, $2)", o.ID, o.Total)
	return err
}

func (s *Store) unexported() {}
