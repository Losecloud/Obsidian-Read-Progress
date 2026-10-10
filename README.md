# Read Progress

Renders a reading progress bar below each markdown note in the Obsidian file explorer.

## Features

- **Per-note progress bar**: a thin bar under every `.md` entry in the file explorer, aligned under the note title.
- **Time Counting Mode (Beta)**: tracks the regions you actually read instead of the cursor position. Re-read areas appear denser; quick scans stay faint. Density scales with reading time up to your goal, then turns into the complete color.
- **Reading time tracking**: WeChat-Read-style timer. Pauses when the window is unfocused, a modal is open, or you scroll away; caps a single region after 5 minutes of idle.
- **Progress stored in `data.json`**: no frontmatter changes to your notes.

## Usage

1. Install the plugin and enable it in Settings → Community plugins.
2. Open any markdown note and scroll — a progress bar appears under the note in the file explorer.
3. Enable **Time Counting Mode (Beta)** in the plugin settings to track real reading regions.
4. Set **How long do you prefer reading?** (minutes) to control when a region reaches the complete color.

## Settings

| Setting | Description |
| --- | --- |
| Time Counting Mode (Beta) | Track actually read regions with time instead of the cursor position |
| How long do you prefer reading? | Reading goal in minutes (e.g. 120 = 2h) |
| Bar width | Width of the progress bar in the file explorer (px) |
| Line width | Thickness (height) of the progress bar line (px) |
| Rounded corners | Fully rounded (pill-shaped) progress bar ends |
| Vertical offset | Distance the bar moves down from the note title (px) |
| Green on complete | Turn the bar green when the reading goal is reached |

## Notes

- System scale above 100% (e.g. 120%, 144%) affects rendering precision; avoid these scale settings for now.
- Requires Obsidian 1.5.0 or later.
