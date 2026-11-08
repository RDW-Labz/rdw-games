"""Decision #75 layout; row order matches the shipped manifest and Rig.

STATES/COLS/FPS are the default (standard-tier) shape — every pack without an
animated `tier` is read exactly this way. T46 (decisions #194, #195, #197-#200)
lets a pack opt into more frames per row, a faster rate and extra rows after
the fixed eight; see docs/t46/formats-avatar.md and docs/t46/contract.md.
"""

FRAME = 128
COLS = 4
STATES = (
    "idle",
    "working",
    "asking",
    "proposal_ready",
    "done",
    "needs_attention",
    "paused",
    "offline",
)
FPS = 6
FRAME_MS = round(1000 / FPS)
SHEET = (FRAME * COLS, FRAME * len(STATES))
LIGHT_BG = "#F4F1EA"
DARK_BG = "#1C1E24"

# Animated tier (T46): §1 of docs/t46/contract.md.
MIN_FRAMES = 4
MAX_FRAMES = 12
MIN_ANIMATED_FPS = 6
MAX_ANIMATED_FPS = 12
MAX_IDLE_VARIANTS = 8
IDLE_VARIANT_PREFIX = "idle_variant_"
CELEBRATE = "celebrate"
