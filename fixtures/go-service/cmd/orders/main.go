package main

import (
	"database/sql"
	"log"
	"net/http"

	"example.com/orders/internal/api"
	"example.com/orders/internal/store"
	_ "github.com/lib/pq"
)

func main() {
	db, err := sql.Open("postgres", "postgres://localhost/orders?sslmode=disable")
	if err != nil {
		log.Fatal(err)
	}
	s := store.New(db)
	log.Fatal(http.ListenAndServe(":8080", api.Router(s)))
}
