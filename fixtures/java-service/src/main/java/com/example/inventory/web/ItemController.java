package com.example.inventory.web;

import com.example.inventory.model.Item;
import com.example.inventory.repo.ItemRepository;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/items")
public class ItemController {
    private final ItemRepository repo;

    public ItemController(ItemRepository repo) {
        this.repo = repo;
    }

    @GetMapping("/{id}")
    public ResponseEntity<Item> get(@PathVariable String id) {
        return repo.find(id).map(ResponseEntity::ok).orElse(ResponseEntity.notFound().build());
    }

    @PostMapping
    public void create(@RequestBody Item item) {
        repo.save(item);
    }

    @RequestMapping(value = "/{id}/restock", method = RequestMethod.PUT)
    public void restock(@PathVariable String id) {}
}
