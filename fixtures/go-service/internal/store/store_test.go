package store

import "testing"

func TestOrderZero(t *testing.T) {
	if (Order{}).Total != 0 {
		t.Fatal("zero order has a total")
	}
}
