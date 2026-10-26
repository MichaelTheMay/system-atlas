import argparse

from notekeeper import store
from notekeeper.export import export_notes


def main() -> None:
    parser = argparse.ArgumentParser(prog="notekeeper")
    sub = parser.add_subparsers(dest="command", required=True)
    add = sub.add_parser("add")
    add.add_argument("title")
    add.add_argument("body")
    sub.add_parser("list")
    exp = sub.add_parser("export")
    exp.add_argument("out_dir")
    serve = sub.add_parser("serve")
    serve.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()

    if args.command == "add":
        print(store.add_note(args.title, args.body))
    elif args.command == "list":
        for note in store.list_notes():
            print(note.id, note.title)
    elif args.command == "export":
        print(export_notes(args.out_dir))
    elif args.command == "serve":
        import uvicorn

        uvicorn.run("notekeeper.api:app", port=args.port)


if __name__ == "__main__":
    main()
