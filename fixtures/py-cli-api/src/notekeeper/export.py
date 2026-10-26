import json
from pathlib import Path

from notekeeper.store import list_notes


def export_notes(out_dir: str) -> Path:
    """Nightly export job: writes all notes as JSON."""
    path = Path(out_dir) / "notes.json"
    path.write_text(json.dumps([n.__dict__ for n in list_notes()], indent=2))
    return path
