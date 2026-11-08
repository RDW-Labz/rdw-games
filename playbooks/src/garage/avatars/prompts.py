"""Six original-art candidate directions from a public, company-free brief."""

import re
import unicodedata
from collections.abc import Mapping

BANNED_NAMES = (
    "R2-D2",
    "Wall-E",
    "Mario",
    "Pikachu",
    "Marvin the Paranoid Android",
    "Dune",
    "Star Wars",
)
FIXED_SETTINGS = (
    "Front view, one character, transparent background, pixel-art-friendly flat shapes. "
    "Original art only; no recognizable character, logo, lettering or catchphrase. "
    "A bold dark outline and a thin light rim; top-left light, clear silhouette at 64 px."
)
VARIATIONS = (
    "Round, compact proportions with a friendly small face",
    "Tall, balanced proportions with a broad expressive face",
    "Soft angular geometry with short sturdy feet",
    "Layered natural shapes with a clear central status band",
    "Simple mechanical shapes with a warm inner light",
    "Playful asymmetric details around a stable central body",
)


def _words(text: str) -> list[str]:
    return [w for w in re.split(r"[^\w]+", unicodedata.normalize("NFKC", text).casefold()) if w]


def _names_in(text: str, name: str) -> bool:
    """True when a run of whole words in ``text``, joined, spells ``name``.

    Whole words, so "sand dunes" never matches Dune, while "R2 D2" and "R2-D2" still match.
    """
    words, target = _words(text), "".join(_words(name))
    return any(
        "".join(words[start:end]) == target
        for start in range(len(words))
        for end in range(start + 1, len(words) + 1)
    )


def candidate_prompts(brief: Mapping[str, object]) -> list[str]:
    """Require a theme and mood word(s); reject known names in any supplied field."""
    text = " ".join(str(value) for value in dict(brief).values())
    for name in BANNED_NAMES:
        if _names_in(text, name):
            raise ValueError(f"brief names a real character or franchise: {name}")
    theme = brief.get("theme")
    mood = brief.get("mood")
    palette = brief.get("palette_hint", "")
    if not isinstance(theme, str) or not theme.strip():
        raise ValueError("brief requires a non-empty theme")
    if isinstance(mood, list) and mood and all(isinstance(w, str) and w.strip() for w in mood):
        mood = ", ".join(mood)
    if not isinstance(mood, str) or not mood.strip():
        raise ValueError("brief requires mood words")
    if not isinstance(palette, str):
        raise ValueError("palette_hint must be text")
    direction = f"Theme: {theme.strip()}. Mood: {mood.strip()}."
    if palette.strip():
        direction += f" Palette hint: {palette.strip()}."
    return [f"{direction} {variation}. {FIXED_SETTINGS}" for variation in VARIATIONS]
