#!/usr/bin/env python3
"""Builds a tiny subset of Tailwind-style utilities for the static pages."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

BASE_DIR = Path(__file__).resolve().parents[1]
OUTPUT_CSS = BASE_DIR / "assets" / "css" / "tailwind-local.css"
HTML_GLOBS = ["**/*.html"]
EXCLUDE_PARTS = {"node_modules", ".git"}
VALID_CLASS = re.compile(r"^[A-Za-z0-9_:\-/\[\]\(\)\.,%]+$")

RESPONSIVE_BREAKPOINTS = {
    "sm": "640px",
    "md": "768px",
    "lg": "1024px",
    "xl": "1280px",
    "2xl": "1536px",
}

PSEUDO_PREFIXES = {
    "hover": ":hover",
    "focus": ":focus",
    "active": ":active",
    "disabled": ":disabled",
}

SPACING_SCALE = {
    "0": "0rem",
    "0.5": "0.125rem",
    "1": "0.25rem",
    "1.5": "0.375rem",
    "2": "0.5rem",
    "2.5": "0.625rem",
    "3": "0.75rem",
    "3.5": "0.875rem",
    "4": "1rem",
    "5": "1.25rem",
    "6": "1.5rem",
    "7": "1.75rem",
    "8": "2rem",
    "9": "2.25rem",
    "10": "2.5rem",
    "11": "2.75rem",
    "12": "3rem",
    "14": "3.5rem",
    "16": "4rem",
    "20": "5rem",
    "24": "6rem",
    "28": "7rem",
    "32": "8rem",
    "40": "10rem",
    "60": "15rem",
}

FONT_SIZES = {
    "text-xs": ("0.75rem", "1rem"),
    "text-sm": ("0.875rem", "1.25rem"),
    "text-base": ("1rem", "1.5rem"),
    "text-lg": ("1.125rem", "1.75rem"),
    "text-xl": ("1.25rem", "1.75rem"),
    "text-2xl": ("1.5rem", "2rem"),
    "text-3xl": ("1.875rem", "2.25rem"),
    "text-4xl": ("2.25rem", "2.5rem"),
    "text-5xl": ("3rem", "1"),
    "text-6xl": ("3.75rem", "1"),
    "text-7xl": ("4.5rem", "1"),
    "text-8xl": ("6rem", "1"),
}

FONT_WEIGHTS = {
    "font-thin": "100",
    "font-extralight": "200",
    "font-light": "300",
    "font-normal": "400",
    "font-medium": "500",
    "font-semibold": "600",
    "font-bold": "700",
    "font-extrabold": "800",
    "font-black": "900",
}

BORDER_RADIUS = {
    "rounded": "0.25rem",
    "rounded-sm": "0.125rem",
    "rounded-md": "0.375rem",
    "rounded-lg": "0.5rem",
    "rounded-xl": "0.75rem",
    "rounded-2xl": "1rem",
    "rounded-3xl": "1.5rem",
    "rounded-full": "9999px",
}

SHADOWS = {
    "shadow-sm": "0 1px 2px 0 rgba(0,0,0,0.05)",
    "shadow": "0 1px 3px 0 rgba(0,0,0,0.1),0 1px 2px 0 rgba(0,0,0,0.06)",
    "shadow-md": "0 4px 6px -1px rgba(0,0,0,0.1),0 2px 4px -1px rgba(0,0,0,0.06)",
    "shadow-lg": "0 10px 15px -3px rgba(0,0,0,0.1),0 4px 6px -2px rgba(0,0,0,0.05)",
    "shadow-xl": "0 20px 25px -5px rgba(0,0,0,0.1),0 10px 10px -5px rgba(0,0,0,0.04)",
    "shadow-2xl": "0 25px 50px -12px rgba(0,0,0,0.25)",
    "shadow-inner": "inset 0 2px 4px 0 rgba(0,0,0,0.06)",
}

COLOR_PALETTE: Dict[str, Dict[str, str]] = {
    "black": {"base": "#000000"},
    "white": {"base": "#ffffff"},
    "transparent": {"base": "transparent"},
    "blue": {"400": "#60a5fa", "500": "#3b82f6", "600": "#2563eb", "700": "#1d4ed8", "900": "#1e3a8a"},
    "emerald": {"300": "#6ee7b7", "400": "#34d399"},
    "gray": {
        "50": "#f9fafb",
        "100": "#f3f4f6",
        "200": "#e5e7eb",
        "300": "#d1d5db",
        "400": "#9ca3af",
        "500": "#6b7280",
        "600": "#4b5563",
        "700": "#374151",
        "800": "#1f2937",
        "900": "#111827",
    },
    "green": {"400": "#4ade80", "500": "#22c55e", "600": "#16a34a", "700": "#15803d", "900": "#14532d"},
    "indigo": {"400": "#818cf8", "500": "#6366f1", "600": "#4f46e5", "700": "#4338ca", "900": "#312e81"},
    "orange": {"50": "#fff7ed", "600": "#ea580c"},
    "purple": {"400": "#c084fc", "500": "#a855f7", "600": "#9333ea", "700": "#7e22ce", "900": "#581c87"},
    "red": {"100": "#fee2e2", "200": "#fecaca", "300": "#fca5a5", "400": "#f87171", "500": "#ef4444", "600": "#dc2626", "700": "#b91c1c", "900": "#7f1d1d"},
    "slate": {"100": "#e2e8f0", "200": "#cbd5f5", "300": "#94a3b8", "400": "#94a3b8", "600": "#475569", "700": "#334155", "800": "#1e293b", "900": "#0f172a", "950": "#020617"},
    "yellow": {"200": "#fef08a", "300": "#fde047", "400": "#facc15", "500": "#eab308", "600": "#ca8a04", "700": "#a16207", "900": "#713f12"},
    "cyan": {"200": "#a5f3fc", "400": "#22d3ee"},
    "accent-yellow": {"base": "#facc15"},
    "card-dark": {"base": "#1f2937"},
    "secondary-green": {"base": "#10b981"},
    "danger-red": {"base": "#ef4444"},
}

LETTER_SPACING = {
    "tracking-tight": "-0.05em",
    "tracking-normal": "0em",
    "tracking-wide": "0.05em",
    "tracking-wider": "0.1em",
}

WIDTH_MAP = {
    "full": "100%",
    "auto": "auto",
    "1/2": "50%",
    "1/3": "33.333333%",
    "4": "1rem",
    "5": "1.25rem",
    "8": "2rem",
    "10": "2.5rem",
    "12": "3rem",
    "14": "3.5rem",
    "16": "4rem",
    "60": "15rem",
}

HEIGHT_MAP = {
    "full": "100%",
    "auto": "auto",
    "screen": "100vh",
    "4": "1rem",
    "5": "1.25rem",
    "8": "2rem",
    "10": "2.5rem",
    "12": "3rem",
    "14": "3.5rem",
    "16": "4rem",
    "20": "5rem",
    "40": "10rem",
}

MAX_WIDTH_MAP = {
    "xs": "20rem",
    "sm": "24rem",
    "md": "28rem",
    "lg": "32rem",
    "xl": "36rem",
    "2xl": "42rem",
    "3xl": "48rem",
    "4xl": "56rem",
    "5xl": "64rem",
    "6xl": "72rem",
    "7xl": "80rem",
}


ARBITRARY_VALUE_RE = re.compile(r"^(?P<prefix>[a-z-]+)-\[(?P<value>[^\]]+)\]$")
DROP_SHADOWS = {
    "drop-shadow": "drop-shadow(0 1px 1px rgba(0,0,0,0.05))",
    "drop-shadow-md": "drop-shadow(0 4px 3px rgba(0,0,0,0.1))",
    "drop-shadow-lg": "drop-shadow(0 10px 8px rgba(0,0,0,0.1))",
    "drop-shadow-xl": "drop-shadow(0 25px 25px rgba(0,0,0,0.15))",
}
EXTRA_RULES: List[str] = []


@dataclass
class RuleSpec:
    selector_suffix: str
    declarations: Sequence[str]


def escape_class(name: str) -> str:
    replacements = {
        ":": r"\\:",
        "/": r"\\/",
        ".": r"\\.",
        "%": r"\\%",
        "#": r"\\#",
        "[": r"\\[",
        "]": r"\\]",
        "(": r"\\(",
        ")": r"\\)",
        ",": r"\\,",
        " ": r"\\ ",
    }
    escaped = name
    for target, repl in replacements.items():
        escaped = escaped.replace(target, repl)
    return escaped


def with_alpha(hex_value: str, alpha: float) -> str:
    hex_value = hex_value.lstrip("#")
    if len(hex_value) == 3:
        hex_value = "".join(ch * 2 for ch in hex_value)
    r = int(hex_value[0:2], 16)
    g = int(hex_value[2:4], 16)
    b = int(hex_value[4:6], 16)
    return f"rgba({r}, {g}, {b}, {alpha})"


def resolve_color(token: str) -> Optional[str]:
    if token.startswith("[") and token.endswith("]"):
        return token[1:-1]
    if token in {"transparent", "current"}:
        return token
    color_part, _, alpha_part = token.partition("/")
    alpha_value: Optional[float] = None
    if alpha_part:
        try:
            alpha_value = float(alpha_part) / 100
        except ValueError:
            alpha_value = None
    if color_part in COLOR_PALETTE and "base" in COLOR_PALETTE[color_part]:
        base_color = COLOR_PALETTE[color_part]["base"]
    else:
        if "-" in color_part:
            color_name, shade = color_part.split("-", 1)
        else:
            color_name, shade = color_part, "base"
        palette = COLOR_PALETTE.get(color_name)
        if not palette:
            return None
        base_color = palette.get(shade) or palette.get("base")
    if not base_color:
        return None
    if alpha_value is not None:
        return with_alpha(base_color, alpha_value)
    return base_color


def spacing_value(token: str) -> Optional[str]:
    if token.startswith("[") and token.endswith("]"):
        return token[1:-1]
    if token == "px":
        return "1px"
    return SPACING_SCALE.get(token)


def parse_class_tokens() -> List[str]:
    classes: set[str] = set()
    pattern = re.compile(r'class="([^"]+)"')
    for glob_pattern in HTML_GLOBS:
        for path in BASE_DIR.glob(glob_pattern):
            if any(part in EXCLUDE_PARTS for part in path.parts):
                continue
            try:
                text = path.read_text()
            except Exception:
                continue
            for match in pattern.finditer(text):
                tokens = re.split(r"\s+", match.group(1).strip())
                for token in tokens:
                    if token and VALID_CLASS.match(token):
                        classes.add(token)
    return sorted(classes)


def rules_for_spacing(prefix: str, token: str) -> List[RuleSpec]:
    props_map = {
        "p": ("padding",),
        "px": ("padding-left", "padding-right"),
        "py": ("padding-top", "padding-bottom"),
        "pt": ("padding-top",),
        "pb": ("padding-bottom",),
        "pl": ("padding-left",),
        "pr": ("padding-right",),
        "m": ("margin",),
        "mx": ("margin-left", "margin-right"),
        "my": ("margin-top", "margin-bottom"),
        "mt": ("margin-top",),
        "mb": ("margin-bottom",),
        "ml": ("margin-left",),
        "mr": ("margin-right",),
    }
    props = props_map[prefix]
    if token == "auto":
        value = "auto"
    else:
        value = spacing_value(token)
    if value is None:
        return []
    return [RuleSpec("", [f"{prop}: {value}" for prop in props])]


def rules_for_space_between(base: str) -> List[RuleSpec]:
    direction = "margin-top" if base.startswith("space-y") else "margin-left"
    token = base.split("-", 2)[2]
    value = spacing_value(token)
    if not value:
        return []
    return [RuleSpec(" > :not([hidden]) ~ :not([hidden])", [f"{direction}: {value}"])]


def rules_for_divide(base: str) -> List[RuleSpec]:
    specs: List[RuleSpec] = []
    selector = " > :not([hidden]) ~ :not([hidden])"
    if base == "divide-y":
        specs.append(RuleSpec(selector, ["border-top-width: 1px", "border-style: solid"]))
    else:
        token = base.split("-", 1)[1]
        color = resolve_color(token)
        if color:
            specs.append(RuleSpec(selector, [f"border-color: {color}"]))
    return specs


def base_rules(base: str) -> List[RuleSpec]:
    specs: List[RuleSpec] = []
    if base in FONT_SIZES:
        size, line_height = FONT_SIZES[base]
        rules = [f"font-size: {size}"]
        if line_height != "1":
            rules.append(f"line-height: {line_height}")
        specs.append(RuleSpec("", rules))
        return specs
    if base in FONT_WEIGHTS:
        specs.append(RuleSpec("", [f"font-weight: {FONT_WEIGHTS[base]}"]))
        return specs
    if base.startswith("text-"):
        alignments = {"text-left": "left", "text-center": "center", "text-right": "right"}
        if base in alignments:
            specs.append(RuleSpec("", [f"text-align: {alignments[base]}"]))
            return specs
        color = resolve_color(base[5:])
        if color:
            specs.append(RuleSpec("", [f"color: {color}"]))
        return specs
    if base.startswith("bg-"):
        token = base[3:]
        if token == "cover":
            specs.append(RuleSpec("", ["background-size: cover"]))
        elif token == "center":
            specs.append(RuleSpec("", ["background-position: center"]))
        else:
            color = resolve_color(token)
            if color:
                specs.append(RuleSpec("", [f"background-color: {color}"]))
        return specs
    if base == "border":
        specs.append(RuleSpec("", ["border-width: 1px", "border-style: solid"]))
        return specs
    if base.startswith("border-"):
        simple = {"border": "1px", "border-2": "2px", "border-4": "4px"}
        if base in simple:
            specs.append(RuleSpec("", [f"border-width: {simple[base]}", "border-style: solid"]))
            return specs
        if base == "border-none":
            specs.append(RuleSpec("", ["border: none"]))
            return specs
        edges = {
            "border-b": "border-bottom-width",
            "border-t": "border-top-width",
            "border-b-4": "border-bottom-width",
            "border-t-4": "border-top-width",
            "border-l-4": "border-left-width",
        }
        if base in edges:
            width = "4px" if base.endswith("-4") else "1px"
            specs.append(RuleSpec("", [f"{edges[base]}: {width}", "border-style: solid"]))
            return specs
        if base.startswith("border-opacity-"):
            opacity = float(base.split("-")[-1]) / 100
            specs.append(RuleSpec("", [f"--tw-border-opacity: {opacity}"]))
            return specs
        color = resolve_color(base.split("-", 1)[1])
        if color:
            specs.append(RuleSpec("", [f"border-color: {color}"]))
        return specs
    if base in BORDER_RADIUS:
        specs.append(RuleSpec("", [f"border-radius: {BORDER_RADIUS[base]}"]))
        return specs
    if base == "rounded-t-xl":
        specs.append(RuleSpec("", ["border-top-left-radius: 0.75rem", "border-top-right-radius: 0.75rem"]))
        return specs
    if base.startswith("shadow"):
        if base in SHADOWS:
            specs.append(RuleSpec("", [f"box-shadow: {SHADOWS[base]}"]))
        elif base.startswith("shadow-["):
            match = ARBITRARY_VALUE_RE.match(base)
            if match:
                specs.append(RuleSpec("", [f"box-shadow: {match.group('value')}"]))
        return specs
    if base.startswith("ring"):
        if base == "ring-2":
            specs.append(RuleSpec("", ["box-shadow: 0 0 0 2px currentColor"]))
        elif base == "ring-offset-2":
            specs.append(RuleSpec("", ["outline-offset: 2px"]))
        else:
            token = base.split("-", 1)[1]
            color = resolve_color(token)
            if color:
                specs.append(RuleSpec("", [f"box-shadow: 0 0 0 2px {color}"]))
        return specs
    for prefix in ("p", "px", "py", "pt", "pb", "pl", "pr", "m", "mx", "my", "mt", "mb", "ml", "mr"):
        if base.startswith(prefix + "-"):
            token = base.split("-", 1)[1]
            specs.extend(rules_for_spacing(prefix, token))
            return specs
    if base.startswith("space-"):
        specs.extend(rules_for_space_between(base))
        return specs
    if base.startswith("divide-"):
        specs.extend(rules_for_divide(base))
        return specs
    if base.startswith("gap"):
        if base.startswith("gap-x-"):
            token = base.split("-", 2)[2]
            value = spacing_value(token)
            if value:
                specs.append(RuleSpec("", [f"column-gap: {value}"]))
        elif base.startswith("gap-y-"):
            token = base.split("-", 2)[2]
            value = spacing_value(token)
            if value:
                specs.append(RuleSpec("", [f"row-gap: {value}"]))
        else:
            token = base.split("-", 1)[1]
            value = spacing_value(token)
            if value:
                specs.append(RuleSpec("", [f"gap: {value}"]))
        return specs
    if base.startswith("w-"):
        token = base[2:]
        value = WIDTH_MAP.get(token)
        if value:
            specs.append(RuleSpec("", [f"width: {value}"]))
        return specs
    if base.startswith("h-"):
        token = base[2:]
        value = HEIGHT_MAP.get(token)
        if value:
            specs.append(RuleSpec("", [f"height: {value}"]))
        return specs
    if base.startswith("min-w-"):
        token = base[6:]
        if token == "full":
            specs.append(RuleSpec("", ["min-width: 100%"]))
        elif token == "0":
            specs.append(RuleSpec("", ["min-width: 0"]))
        elif token.startswith("["):
            specs.append(RuleSpec("", [f"min-width: {token[1:-1]}"]))
        return specs
    if base.startswith("min-h-"):
        token = base[6:]
        if token == "screen":
            specs.append(RuleSpec("", ["min-height: 100vh"]))
        elif token.startswith("["):
            specs.append(RuleSpec("", [f"min-height: {token[1:-1]}"]))
        return specs
    if base.startswith("max-w-"):
        token = base[6:]
        if token.startswith("["):
            specs.append(RuleSpec("", [f"max-width: {token[1:-1]}"]))
        else:
            value = MAX_WIDTH_MAP.get(token)
            if value:
                specs.append(RuleSpec("", [f"max-width: {value}"]))
        return specs
    if base.startswith("max-h-"):
        token = base[6:]
        if token.startswith("["):
            specs.append(RuleSpec("", [f"max-height: {token[1:-1]}"]))
        elif token in SPACING_SCALE:
            specs.append(RuleSpec("", [f"max-height: {SPACING_SCALE[token]}"]))
        return specs
    if base.startswith("grid-cols-"):
        token = base[10:]
        if token.startswith("["):
            specs.append(RuleSpec("", [f"grid-template-columns: {token[1:-1]}"]))
        else:
            specs.append(RuleSpec("", [f"grid-template-columns: repeat({token}, minmax(0, 1fr))"]))
        return specs
    if base.startswith("col-span-"):
        token = base[9:]
        if token == "full":
            specs.append(RuleSpec("", ["grid-column: 1 / -1"]))
        else:
            specs.append(RuleSpec("", [f"grid-column: span {token} / span {token}"]))
        return specs
    display_map = {
        "block": "block",
        "inline-block": "inline-block",
        "inline": "inline",
        "flex": "flex",
        "inline-flex": "inline-flex",
        "grid": "grid",
        "hidden": "none",
    }
    if base in display_map:
        specs.append(RuleSpec("", [f"display: {display_map[base]}"]))
        return specs
    if base in {"absolute", "relative", "fixed", "sticky"}:
        specs.append(RuleSpec("", [f"position: {base}"]))
        return specs
    if base == "inset-0":
        specs.append(RuleSpec("", ["top: 0", "right: 0", "bottom: 0", "left: 0"]))
        return specs
    if base.startswith("top-") or base.startswith("bottom-") or base.startswith("left-"):
        prop, token = base.split("-", 1)
        value = "0" if token == "0" else ("50%" if token == "1/2" else spacing_value(token))
        if value:
            specs.append(RuleSpec("", [f"{prop}: {value}"]))
        return specs
    if base.startswith("-mt-"):
        token = base[4:]
        value = spacing_value(token)
        if value:
            specs.append(RuleSpec("", [f"margin-top: -{value}"]))
        return specs
    if base.startswith("-translate-y-"):
        token = base[len("-translate-y-"):]
        if token == "1/2":
            specs.append(RuleSpec("", ["transform: translateY(-50%)"]))
        return specs
    if base.startswith("scale-"):
        token = base[6:]
        if token.startswith("["):
            value = token[1:-1]
        else:
            try:
                value = str(float(token) / 100)
            except ValueError:
                value = None
        if value:
            specs.append(RuleSpec("", [f"transform: scale({value})"]))
        return specs
    if base.startswith("opacity-"):
        value = int(base.split("-")[1]) / 100
        specs.append(RuleSpec("", [f"opacity: {value}"]))
        return specs
    if base.startswith("leading-"):
        values = {"none": "1", "tight": "1.25", "relaxed": "1.625"}
        token = base.split("-", 1)[1]
        value = values.get(token)
        if value:
            specs.append(RuleSpec("", [f"line-height: {value}"]))
        return specs
    if base.startswith("tracking-"):
        if base in LETTER_SPACING:
            specs.append(RuleSpec("", [f"letter-spacing: {LETTER_SPACING[base]}"]))
        elif base.startswith("tracking-["):
            specs.append(RuleSpec("", [f"letter-spacing: {base.split('[',1)[1][:-1]}"]))
        return specs
    if base in {"uppercase", "lowercase", "capitalize"}:
        specs.append(RuleSpec("", [f"text-transform: {base}"]))
        return specs
    if base.startswith("justify-"):
        mapping = {"center": "center", "between": "space-between", "start": "flex-start", "end": "flex-end"}
        token = base.split("-", 1)[1]
        value = mapping.get(token)
        if value:
            specs.append(RuleSpec("", [f"justify-content: {value}"]))
        return specs
    if base.startswith("items-"):
        mapping = {"center": "center", "start": "flex-start", "end": "flex-end"}
        token = base.split("-", 1)[1]
        value = mapping.get(token)
        if value:
            specs.append(RuleSpec("", [f"align-items: {value}"]))
        return specs
    if base == "flex-row":
        specs.append(RuleSpec("", ["flex-direction: row"]))
        return specs
    if base == "flex-col":
        specs.append(RuleSpec("", ["flex-direction: column"]))
        return specs
    if base == "flex-nowrap":
        specs.append(RuleSpec("", ["flex-wrap: nowrap"]))
        return specs
    if base == "flex-wrap":
        specs.append(RuleSpec("", ["flex-wrap: wrap"]))
        return specs
    if base == "flex-1":
        specs.append(RuleSpec("", ["flex: 1 1 0%"]))
        return specs
    if base == "flex-grow":
        specs.append(RuleSpec("", ["flex-grow: 1"]))
        return specs
    if base == "flex-shrink-0":
        specs.append(RuleSpec("", ["flex-shrink: 0"]))
        return specs
    if base == "self-center":
        specs.append(RuleSpec("", ["align-self: center"]))
        return specs
    if base == "self-start":
        specs.append(RuleSpec("", ["align-self: flex-start"]))
        specs.append(RuleSpec("", ["flex-shrink: 0"]))
        return specs
    if base == "overflow-hidden":
        specs.append(RuleSpec("", ["overflow: hidden"]))
        return specs
    if base == "overflow-x-auto":
        specs.append(RuleSpec("", ["overflow-x: auto"]))
        return specs
    if base == "overflow-y-auto":
        specs.append(RuleSpec("", ["overflow-y: auto"]))
        return specs
    if base == "truncate":
        specs.append(RuleSpec("", ["overflow: hidden", "text-overflow: ellipsis", "white-space: nowrap"]))
        return specs
    if base == "whitespace-nowrap":
        specs.append(RuleSpec("", ["white-space: nowrap"]))
        return specs
    if base.startswith("transition"):
        if base == "transition":
            specs.append(RuleSpec("", ["transition-property: all", "transition-duration: 150ms", "transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1)"]))
        elif base == "transition-all":
            specs.append(RuleSpec("", ["transition-property: all"]))
        elif base == "transition-colors":
            specs.append(RuleSpec("", ["transition-property: color, background-color, border-color, text-decoration-color, fill, stroke"]))
        elif base == "transition-transform":
            specs.append(RuleSpec("", ["transition-property: transform"]))
        return specs
    if base.startswith("duration-"):
        value = f"{base.split('-',1)[1]}ms"
        specs.append(RuleSpec("", [f"transition-duration: {value}"]))
        return specs
    if base == "ease-in-out":
        specs.append(RuleSpec("", ["transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1)"]))
        return specs
    if base == "cursor-pointer":
        specs.append(RuleSpec("", ["cursor: pointer"]))
        return specs
    if base == "cursor-not-allowed":
        specs.append(RuleSpec("", ["cursor: not-allowed"]))
        return specs
    if base == "underline":
        specs.append(RuleSpec("", ["text-decoration: underline"]))
        return specs
    if base == "italic":
        specs.append(RuleSpec("", ["font-style: italic"]))
        return specs
    if base == "font-mono":
        specs.append(RuleSpec("", ["font-family: 'IBM Plex Mono', 'Courier New', monospace"]))
        return specs
    if base == "font-title":
        specs.append(RuleSpec("", ["font-family: 'Bebas Neue', sans-serif"]))
        return specs
    if base == "text-[10px]":
        specs.append(RuleSpec("", ["font-size: 10px"]))
        return specs
    if base == "pt-[100px]":
        specs.append(RuleSpec("", ["padding-top: 100px"]))
        return specs
    if base.startswith("tracking-["):
        specs.append(RuleSpec("", [f"letter-spacing: {base.split('[',1)[1][:-1]}"]))
        return specs
    if base.startswith("z-"):
        token = base[2:]
        value = token[1:-1] if token.startswith("[") else token
        specs.append(RuleSpec("", [f"z-index: {value}"]))
        return specs
    if base == "backdrop-blur-sm":
        specs.append(RuleSpec("", ["backdrop-filter: blur(4px)"]))
        return specs
    if base == "appearance-none":
        specs.append(RuleSpec("", ["appearance: none"]))
        return specs
    if base == "outline-none":
        specs.append(RuleSpec("", ["outline: none"]))
        return specs
    if base == "select-all":
        specs.append(RuleSpec("", ["user-select: all"]))
        return specs
    if base == "object-cover":
        specs.append(RuleSpec("", ["object-fit: cover"]))
        return specs
    if base == "object-contain":
        specs.append(RuleSpec("", ["object-fit: contain"]))
        return specs
    if base == "placeholder-gray-400":
        specs.append(RuleSpec("::placeholder", ["color: #9ca3af"]))
        return specs
    if base in DROP_SHADOWS:
        specs.append(RuleSpec("", [f"filter: {DROP_SHADOWS[base]}"]))
        return specs
    if base == "animate-spin":
        EXTRA_RULES.append("@keyframes tailwind-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }")
        specs.append(RuleSpec("", ["animation: tailwind-spin 1s linear infinite"]))
        return specs
    if base == "form-checkbox":
        specs.append(RuleSpec("", ["appearance: none", "width: 1rem", "height: 1rem", "border: 1px solid #d1d5db", "border-radius: 0.25rem"]))
        return specs
    if base == "form-radio":
        specs.append(RuleSpec("", ["appearance: none", "width: 1rem", "height: 1rem", "border: 1px solid #d1d5db", "border-radius: 9999px"]))
        return specs
    if base == "container":
        specs.append(RuleSpec("", ["width: 100%", "max-width: 1200px", "margin-left: auto", "margin-right: auto", "padding-left: 1rem", "padding-right: 1rem"]))
        return specs
    if base == "transform":
        specs.append(RuleSpec("", ["transform: translateZ(0)"]))
        return specs
    if base.startswith("grid-cols-["):
        specs.append(RuleSpec("", [f"grid-template-columns: {base.split('[',1)[1][:-1]}"]))
        return specs
    return specs


def build_css() -> None:
    classes = parse_class_tokens()
    css_rules: List[str] = []
    for cls in classes:
        if ':' in cls:
            prefix, base = cls.split(':', 1)
        else:
            prefix, base = None, cls
        specs = base_rules(base)
        if not specs:
            continue
        pseudo = PSEUDO_PREFIXES.get(prefix)
        media = RESPONSIVE_BREAKPOINTS.get(prefix)
        selector_base = f".{escape_class(cls)}"
        for spec in specs:
            selector = selector_base + (pseudo or '') + spec.selector_suffix
            rule_body = '; '.join(spec.declarations)
            rule = f"{selector} {{{rule_body}}}"
            if media:
                rule = f"@media (min-width: {media}) {{{rule}}}"
            css_rules.append(rule)
    OUTPUT_CSS.parent.mkdir(parents=True, exist_ok=True)
    final_css = css_rules + EXTRA_RULES
    OUTPUT_CSS.write_text('\n'.join(final_css) + '\n')
    print(f"Generated {len(css_rules)} CSS rules -> {OUTPUT_CSS}")


if __name__ == "__main__":
    build_css()
