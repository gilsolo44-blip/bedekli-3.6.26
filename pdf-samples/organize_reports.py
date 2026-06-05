#!/usr/bin/env python3
"""
organize_reports.py — בדק בית PDF Organizer
Phase 1 (--dry-run): Scan every PDF with Claude Vision → build mapping.json
Phase 2 (--execute):  Move files into "Company [Count]" folders
"""

import os
import sys
import json
import time
import base64
import shutil
import argparse
import io
from pathlib import Path
from collections import Counter
from typing import Optional

try:
    from pdf2image import convert_from_path
    import anthropic
except ImportError as e:
    sys.exit(f"Missing dependency: {e}\nRun: pip3 install pdf2image anthropic")

# ─── Config ───────────────────────────────────────────────────────────────────
DIR          = Path(__file__).parent
MAPPING_FILE = DIR / "mapping.json"
MODEL        = "claude-sonnet-4-6"
POPPLER_PATH = "/opt/homebrew/bin"
RARE_THRESHOLD = 2      # ≤ this many files → goes into "חברות שונות"
CALL_DELAY   = 0.4      # seconds between API calls (rate-limit safety)

SYSTEM_PROMPT = """\
אתה מומחה לזיהוי חברות בדק בית ישראליות.
תפקידך: לזהות את שם החברה או המהנדס שיצר את דוח הבדק בית מהתמונה הראשונה של הדוח.

חפש: לוגו, כותרת, שם חברה, חותמת, שם מהנדס בכותרת.
אל תזהה: שם הנכס, שם הלקוח, כתובת הנכס.

חברות ידועות לדוגמה: גולדאל הנדסה, דובי, פלס, הורוביץ.

ענה **אך ורק** בשם החברה/המהנדס בעברית — בלי הסברים, בלי נקודות.
אם אינך יכול לזהות בוודאות — ענה: לא זוהה"""

# ─── PDF → Image ──────────────────────────────────────────────────────────────

def pdf_first_page_b64(pdf_path: Path) -> Optional[str]:
    """Return base64-encoded JPEG of the first page, or None on failure."""
    try:
        pages = convert_from_path(
            str(pdf_path),
            first_page=1, last_page=1,
            dpi=150, fmt="jpeg",
            poppler_path=POPPLER_PATH,
        )
        if not pages:
            return None
        buf = io.BytesIO()
        pages[0].save(buf, format="JPEG", quality=85)
        return base64.standard_b64encode(buf.getvalue()).decode()
    except Exception as e:
        print(f"  ⚠ conversion failed: {e}")
        return None

# ─── Claude Vision ────────────────────────────────────────────────────────────

def detect_company(client: anthropic.Anthropic, image_b64: str, filename: str) -> str:
    """Send first-page image to Claude and return company name."""
    try:
        response = client.messages.create(
            model=MODEL,
            max_tokens=80,
            system=[
                {
                    "type": "text",
                    "text": SYSTEM_PROMPT,
                    "cache_control": {"type": "ephemeral"},  # reuse across 295 calls
                }
            ],
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": "image/jpeg",
                                "data": image_b64,
                            },
                        },
                        {
                            "type": "text",
                            "text": f"שם קובץ: {filename}\nמה שם החברה/המהנדס?",
                        },
                    ],
                }
            ],
        )
        return response.content[0].text.strip()
    except anthropic.RateLimitError:
        print("  ⏳ rate-limit, waiting 30s...", flush=True)
        time.sleep(30)
        return detect_company(client, image_b64, filename)
    except anthropic.APIError as e:
        print(f"  ✗ API error: {e}")
        return "שגיאה"

# ─── Phase 1: Dry Run ─────────────────────────────────────────────────────────

def run_dry_run(api_key: str):
    client = anthropic.Anthropic(api_key=api_key)

    # Resumable: load any prior progress
    mapping: dict = {}
    if MAPPING_FILE.exists():
        with open(MAPPING_FILE, encoding="utf-8") as f:
            mapping = json.load(f)
        print(f"Resuming — {len(mapping)} already processed.\n")

    pdfs = sorted(DIR.glob("*.pdf"))
    total = len(pdfs)
    print(f"Found {total} PDFs in:\n  {DIR}\n")

    for i, pdf in enumerate(pdfs, 1):
        if pdf.name in mapping:
            print(f"[{i:>3}/{total}] ⏭  {pdf.name[:55]:<55} → {mapping[pdf.name]}")
            continue

        print(f"[{i:>3}/{total}] 🔍 {pdf.name[:55]:<55}", end=" ", flush=True)
        img_b64 = pdf_first_page_b64(pdf)

        if img_b64 is None:
            company = "שגיאת המרה"
            print(f"✗ {company}")
        else:
            company = detect_company(client, img_b64, pdf.name)
            print(f"→ {company}")

        mapping[pdf.name] = company

        # Persist after every file (safe to interrupt)
        with open(MAPPING_FILE, "w", encoding="utf-8") as f:
            json.dump(mapping, f, ensure_ascii=False, indent=2)

        time.sleep(CALL_DELAY)

    print_summary(mapping)


def print_summary(mapping: dict):
    counts = Counter(mapping.values())
    print("\n" + "═" * 65)
    print("📊  Company Detection Summary")
    print("═" * 65)
    rare_total = 0
    for company, count in counts.most_common():
        if count <= RARE_THRESHOLD:
            marker, label = "⚠", f"→ חברות שונות"
            rare_total += count
        else:
            marker, label = "✓", ""
        print(f"  {marker}  {company:<35} {count:>4} files  {label}")
    print("─" * 65)
    print(f"  Total files: {sum(counts.values())}   Unique companies: {len(counts)}")
    print(f"  חברות שונות bucket: {rare_total} files (≤{RARE_THRESHOLD} each)")
    print("═" * 65)
    print(f"\n✅  mapping.json → {MAPPING_FILE}")
    print("Review the file, then run:  python3 organize_reports.py --execute\n")


# ─── Phase 2: Execute ─────────────────────────────────────────────────────────

def run_execute():
    if not MAPPING_FILE.exists():
        sys.exit("mapping.json not found — run --dry-run first.")

    with open(MAPPING_FILE, encoding="utf-8") as f:
        mapping = json.load(f)

    counts = Counter(mapping.values())

    # Build folder name map
    rare_companies = {c for c, n in counts.items() if n <= RARE_THRESHOLD}
    rare_total     = sum(counts[c] for c in rare_companies)
    rare_folder    = DIR / f"חברות שונות [{rare_total}]"

    folder_map: dict = {}
    for company, count in counts.items():
        if company not in rare_companies:
            folder_map[company] = DIR / f"{company} [{count}]"

    # Create directories
    for folder in list(folder_map.values()) + ([rare_folder] if rare_total else []):
        folder.mkdir(exist_ok=True)
        print(f"📁 {folder.name}")

    # Move files
    moved = errors = 0
    for filename, company in mapping.items():
        src = DIR / filename
        if not src.exists():
            print(f"  ⚠ missing: {filename}")
            errors += 1
            continue

        dest_dir = folder_map.get(company, rare_folder)
        shutil.move(str(src), str(dest_dir / filename))
        print(f"  → {filename[:50]} → {dest_dir.name}")
        moved += 1

    print(f"\n✅  Moved {moved} files.  Errors: {errors}.")

# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Organize בדק בית PDFs into company folders using Claude Vision"
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--dry-run",  action="store_true",
                       help="Analyze PDFs, build mapping.json (safe — no files moved)")
    group.add_argument("--execute",  action="store_true",
                       help="Move files based on existing mapping.json")
    parser.add_argument("--api-key", default=os.getenv("ANTHROPIC_API_KEY"),
                        help="Anthropic API key (or set ANTHROPIC_API_KEY env var)")
    args = parser.parse_args()

    if args.dry_run:
        if not args.api_key:
            sys.exit("Error: provide --api-key or set ANTHROPIC_API_KEY env var.")
        run_dry_run(args.api_key)
    else:
        run_execute()

if __name__ == "__main__":
    main()
