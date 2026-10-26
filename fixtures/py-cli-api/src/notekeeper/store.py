import sqlite3
from dataclasses import dataclass

DB_PATH = "notes.db"


@dataclass
class Note:
    id: int
    title: str
    body: str


def connect() -> sqlite3.Connection:
    return sqlite3.connect(DB_PATH)


def add_note(title: str, body: str) -> Note:
    with connect() as conn:
        cur = conn.execute("INSERT INTO notes (title, body) VALUES (?, ?)", (title, body))
        return Note(cur.lastrowid, title, body)


def list_notes() -> list[Note]:
    with connect() as conn:
        return [Note(*row) for row in conn.execute("SELECT id, title, body FROM notes")]


def get_note(note_id: int) -> Note | None:
    with connect() as conn:
        row = conn.execute("SELECT id, title, body FROM notes WHERE id = ?", (note_id,)).fetchone()
        return Note(*row) if row else None
