package api

import (
	"encoding/json"
	"net/http"

	"example.com/orders/internal/store"
	"github.com/go-chi/chi/v5"
)

// Router wires the HTTP endpoints of the orders service.
func Router(s *store.Store) http.Handler {
	r := chi.NewRouter()
	r.Get("/orders/{id}", func(w http.ResponseWriter, req *http.Request) {
		o, err := s.Get(req.Context(), chi.URLParam(req, "id"))
		if err != nil {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		_ = json.NewEncoder(w).Encode(o)
	})
	r.Post("/orders", func(w http.ResponseWriter, req *http.Request) {
		var o store.Order
		_ = json.NewDecoder(req.Body).Decode(&o)
		_ = s.Create(req.Context(), o)
		w.WriteHeader(http.StatusCreated)
	})
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	mux.Handle("/", r)
	return mux
}
