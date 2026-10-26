from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from notekeeper import store

app = FastAPI(title="notekeeper")


class NoteIn(BaseModel):
    title: str
    body: str


@app.get("/notes")
def list_notes():
    return store.list_notes()


@app.post("/notes")
def create_note(note: NoteIn):
    return store.add_note(note.title, note.body)


@app.get("/notes/{note_id}")
def read_note(note_id: int):
    note = store.get_note(note_id)
    if note is None:
        raise HTTPException(status_code=404)
    return note
