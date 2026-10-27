package com.example.inventory.repo;

import com.example.inventory.model.Item;
import java.util.Optional;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

@Repository
public class ItemRepository {
    private final JdbcTemplate jdbc;

    public ItemRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public Optional<Item> find(String id) {
        return jdbc.query("SELECT id, name, quantity FROM items WHERE id = ?",
                (rs, n) -> new Item(rs.getString(1), rs.getString(2), rs.getInt(3)), id).stream().findFirst();
    }

    public void save(Item item) {
        jdbc.update("INSERT INTO items (id, name, quantity) VALUES (?, ?, ?)", item.id(), item.name(), item.quantity());
    }

    void reindex() {}
}
