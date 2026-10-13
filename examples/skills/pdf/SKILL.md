---
name: pdf
description: |
  PDF production for pico agents: build PDFs from Markdown (reports, letters,
  notes) or LaTeX (papers), and process existing PDFs (extract text, merge,
  split, page count, page images). Use whenever the final output of a task is
  a PDF, or when pulling content apart from one — including phrasings like
  "export as PDF", "Word转PDF", "merge these PDFs", "extract page 3".
---

# PDF production

You have bash, read, write, and edit. Everything below runs through those
tools; nothing here needs a new tool.

## 0. Preflight (always, before any route)

Check what is installed before choosing a route — never assume:

```bash
pandoc --version | head -1        # Markdown route
tectonic --version | head -1      # LaTeX route
python3 -c "import pypdf; print(pypdf.__version__)"   # existing-PDF route
fc-list | grep -i -E "noto.*cjk|song|hei" | head -3   # CJK font coverage
```

Rules:

- Install nothing without asking the user first; pick the route the present
  tools support. If none is present, report what is missing and stop.
- CJK content needs font coverage. With pandoc use
  `-V CJKmainfont="Noto Sans CJK SC"`; with LaTeX use `\usepackage{ctex}`.
- Write outputs next to the source file, and report the absolute path when
  done.

## 1. Markdown → PDF (reports, letters, simple docs)

Default route for prose documents. Keep the source Markdown around — the
user will likely iterate.

```bash
pandoc report.md -o report.pdf \
  -V geometry:margin=2.5cm \
  -V CJKmainfont="Noto Sans CJK SC" \
  --toc
```

Iterate on layout via pandoc variables (fontsize, geometry, mainfont). For
slide-shaped output ask the user first: `-t beamer` changes the document
kind, not just the look.

## 2. LaTeX → PDF (papers, math-heavy documents)

Only when the user provides `.tex` or explicitly asks for LaTeX. Do not hand
convert Markdown to LaTeX unless asked — route 1 is the default.

```bash
tectonic paper.tex
```

`tectonic` fetches packages on first use (slow, network) — say so before the
first build in a new environment.

## 3. Existing PDFs (extract, merge, split, inspect)

```bash
python3 - <<'EOF'
from pypdf import PdfReader, PdfWriter
r = PdfReader("in.pdf")
print("pages:", len(r.pages))
print(r.pages[0].extract_text()[:500])        # extract text (page 1)
w = PdfWriter()
for p in r.pages[1:]:                          # split: keep pages 2..end
    w.add_page(p)
with open("out.pdf", "wb") as f:
    w.write(f)
EOF
```

Merging: `PdfWriter().append("a.pdf").append("b.pdf")`. Page images need an
extra dependency (PyMuPDF) — ask before installing.

## 4. Verify before reporting done

Every route ends with the same check, then report the absolute output path
and the page count:

```bash
python3 -c "from pypdf import PdfReader; r=PdfReader('out.pdf'); print('pages:', len(r.pages))"
```

If the build failed, show the actual compiler error to the user — do not
paraphrase it away.
