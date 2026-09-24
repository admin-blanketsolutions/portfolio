from __future__ import annotations


class ParseError(Exception):
    """A rejection the uploader can act on.

    `code` is a stable machine identifier (the API maps it to a message);
    `message` is written for auditors and never echoes cell contents beyond a
    row number, so a hostile file cannot inject text into downstream logs.
    """

    def __init__(self, code: str, message: str, row: int | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.row = row

    def to_dict(self) -> dict[str, object]:
        out: dict[str, object] = {"code": self.code, "message": self.message}
        if self.row is not None:
            out["row"] = self.row
        return out
