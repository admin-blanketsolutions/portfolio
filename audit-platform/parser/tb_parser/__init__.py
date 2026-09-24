"""Sandboxed trial-balance parser.

Turns an untrusted client TB file (.xlsx or .csv) into a typed, normalised
result with control totals. It never evaluates formulas, never follows links,
never touches the network, and refuses active content. See
docs/01-adversarial-security-review.md section 3 for the threat model.
"""

__version__ = "0.1.0"
PARSER_VERSION = f"tb-parser@{__version__}"

from .errors import ParseError  # noqa: E402
from .limits import Limits  # noqa: E402
from .parse import parse_bytes  # noqa: E402

__all__ = ["PARSER_VERSION", "Limits", "ParseError", "parse_bytes"]
