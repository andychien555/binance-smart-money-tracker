# Linear — Style Reference
> Midnight Command Center: A dark, layered interface lit by precise accents, like a high-tech control panel.

**Theme:** dark

Linear presents a sophisticated and focused dark-mode experience, reminiscent of a command center dashboard. A deep charcoal base creates a serious, immersive canvas, while subtle gradients and layered surfaces build depth without harsh contrasts. Distinctive muted text colors (#8a8f98 for secondary, #62666d for tertiary) maintain readability against the dark backdrop. Critically, interaction is marked by a single vivid lime green (#e4f222), applied selectively to primary calls to action, preventing visual clutter and guiding the user's eye with precision.

## Colors

| Name | Value | Role |
|------|-------|------|
| Pitch Black | `#08090a` | Page background, primary surface for base elements, subtly integrated into shadows for depth. |
| Graphite | `#0f1011` | Elevated card backgrounds, slightly lighter than the canvas to denote layering. |
| Deep Slate | `#161718` | Secondary elevated card backgrounds, providing another layer of visual hierarchy. |
| Charcoal Grey | `#23252a` | Borders and some shadowed card surfaces, framing elements with a subtle distinction. |
| Muted Ash | `#323334` | Subtle borders and dividers, indicating soft separations within the dark theme. |
| Gunmetal | `#383b3f` | Tertiary background elements and input borders, a darker neutral for functional elements. |
| Porcelain | `#f7f8f8` | Primary text and icons, providing strong contrast for readability against dark backgrounds. |
| Light Steel | `#d0d6e0` | Secondary text and borders, for less prominent information or structural lines. |
| Storm Cloud | `#8a8f98` | Tertiary text, descriptive labels, and inactive states, recedes into the background for low-priority details. |
| Fog Grey | `#62666d` | Muted text for metadata, timestamps, and further de-emphasized content. |
| Alabaster | `#e5e5e6` | Informational borders and subtle fills, often seen in code blocks or explanatory components. |
| Neon Lime | `#e4f222` | Primary action indicators, active states, and focus elements — a high-energy focal point. |
| Aether Blue | `#5e6ad2` | Decorative highlights and occasional background elements, suggesting a technological or informational context. |
| Forest Green | `#008d2c` | Positive status indicators, success messages, and related iconography. |
| Cyan Spark | `#02b8cc` | Informational highlights and unique icon fills, providing a cool accent. |
| Emerald | `#27a644` | Success and completion states, often paired with green text. |
| Warning Red | `#eb5757` | Observed in icon fill, body borderColor, other fill. Extracted usage does not support a distinct primary control color. |
| Deep Violet | `#6366f1` | Background accents in specific content blocks, indicating a distinct informational category. |
| Amethyst | `#8b5cf6` | Another variant of violet for backgrounds, used interchangeably with Deep Violet for visual diversity. |

## Typography

### Inter Variable — Primary UI typeface for all content including headings, body text, and interactive elements. Its variable weights provide a clean, modern aesthetic with strong technical readability.
- **Substitute:** Inter
- **Weights:** 300, 400, 510, 590
- **Sizes:** 10px, 11px, 12px, 13px, 14px, 15px, 16px, 17px, 20px, 24px, 32px, 48px, 64px, 72px
- **Line height:** 1.00, 1.13, 1.20, 1.33, 1.40, 1.47, 1.50, 1.60, 2.00, 2.46, 2.75
- **Letter spacing:** -0.22, -0.15, -0.13, -0.12, -0.11, -0.1
- **OpenType features:** `"cv01", "ss03"`

### Berkeley Mono — Monospaced font for code snippets, technical details, and certain data displays, ensuring consistent character alignment and technical clarity.
- **Substitute:** IBM Plex Mono
- **Weights:** 400
- **Sizes:** 12px, 13px, 14px
- **Line height:** 1.30, 1.40, 1.50, 1.71
- **Letter spacing:** -0.15

### Type Scale

| Role | Size | Line Height | Letter Spacing |
|------|------|-------------|----------------|
| caption | 10px | 1.4 | -0.1px |
| body | 14px | 1.4 | -0.13px |
| heading | 24px | 1.33 | -0.22px |
| heading-lg | 48px | 1.2 | -0.22px |
| display | 72px | 1 | -0.22px |

## Spacing & Layout

**Base unit:** 4px

**Density:** compact

- **Section gap:** 24px
- **Card padding:** 12px
- **Element gap:** 8px

### Border Radius

- **pill:** 9999px
- **tags:** 2px
- **cards:** 6px
- **badges:** 4px
- **inputs:** 6px
- **buttons:** 6px
- **default:** 6px

## Components

### Primary Action Button
**Role:** Call to action button

Filled button with 'Neon Lime' background (#e4f222), 'Pitch Black' text (#08090a), 6px border-radius, and variable padding. Used for primary user actions.

### Ghost Navigation Button
**Role:** Navigation and secondary actions

Ghost button with transparent background, 'Porcelain' text (#f7f8f8), no explicit padding, and 0px border-radius. Navigational links or simple interactive elements.

### Subtle Link Button
**Role:** Tertiary actions and links

Ghost button with transparent background, 'Light Steel' text (#d0d6e0), 6px border-radius, and minimal padding (0px top/bottom, 6px left/right). Used for less prominent interactive elements or textual links.

### Navigation Item Button
**Role:** Sidebar navigation items

Ghost button with transparent background, 'Storm Cloud' text (#8a8f98), 2px border-radius, and no explicit padding. Used for items in a navigation list.

### Default Card
**Role:** Content container

Card with 'Graphite' background (#0f1011), 6px border-radius, and an outer shadow of rgba(0, 0, 0, 0.4) 0px 2px 4px 0px. Padding is 8px on all sides.

### Elevated Card
**Role:** Prominent content container

Card with 'Deep Slate' background (#161718), 12px top border-radius (0px bottom), and an inset shadow of rgb(35, 37, 42) 0px 0px 0px 1px. Padding is 24px vertical and 0px horizontal.

### Nested Card
**Role:** Internal content grouping

Card with 'Pitch Black' background (#08090a) and 12px border-radius, no shadow. Padding 8px on all sides, used for containing sub-elements within larger cards.

### Input Field
**Role:** User input fields

Input field with transparent background, 'Porcelain' text (#f7f8f8), 'Charcoal Grey' border (#23252a), and 6px border-radius. Padding is 12px vertical and 14px horizontal.

### Subtle Input Field
**Role:** Search or secondary input fields

Input field with 'Gunmetal' background (#383b3f), 'Porcelain' text (#f7f8f8), no explicit border, and 0px border-radius. Used for less emphasized data entry.

### Badge
**Role:** Label or tag

Badge with a 'Gunmetal' background (#383b3f), 'Storm Cloud' text (#8a8f98), 4px border-radius, and padding of 0px vertical and 6px horizontal. Used for small categorical labels.

## Do's and Don'ts

### Do
- Use 'Pitch Black' (#08090a) for the primary page background to establish the dark theme.
- Apply 'Porcelain' (#f7f8f8) for all primary text and important icons to ensure readability.
- Highlight primary interactive elements exclusively with 'Neon Lime' (#e4f222) as a background, restricting its use to guide user attention.
- Create depth and hierarchy by layering surfaces using 'Pitch Black' (#08090a), 'Graphite' (#0f1011), and 'Deep Slate' (#161718) backgrounds.
- Employ the Inter Variable font family with specific letter-spacing adjustments for all UI text, such as -0.22px for display sizes and -0.11px for body text, to maintain a tight, precise feel.
- Utilize 6px border-radius for all primary buttons, cards, and input fields to maintain a consistent, subtly rounded aesthetic.
- Use 'Storm Cloud' (#8a8f98) for secondary text and descriptive labels to recede into the background.

### Don't
- Do not introduce additional bright or saturated colors beyond 'Neon Lime' (#e4f222) for interactive elements; maintain its singular role.
- Avoid using harsh white backgrounds or light-themed patterns, as the system is anchored in a dark mode aesthetic.
- Do not deviate from the specified typeface choices; 'Inter Variable' and 'Berkeley Mono' are fundamental to the visual identity.
- Refrain from using strong, diffuse shadows; elevation is achieved through subtle layering and sharp, contained shadows like rgba(0, 0, 0, 0.4) 0px 2px 4px 0px.
- Do not apply broad, decorative background gradients across large sections of the UI; gradients are subtle and contained to specific functional areas.
- Do not use generic border-radii; adhere to 6px for key components like cards and buttons, and 2px for smaller tags, to preserve the signature balance of softness and precision.
- Avoid large amounts of white space; the design is compact, leveraging an 8px element gap as a standard measurement.

## Elevation

- **Default Card:** `rgba(0, 0, 0, 0.4) 0px 2px 4px 0px`
- **Sidebar/Menu Element Focus:** `rgba(0, 0, 0, 0.2) 0px 0px 12px 0px inset`
- **Elevated Card Inset:** `rgb(35, 37, 42) 0px 0px 0px 1px inset`
- **Card Border/Input Focus:** `rgba(0, 0, 0, 0.2) 0px 0px 0px 1px`
- **Navigation/Button Subtle Lift:** `rgba(0, 0, 0, 0.01) 0px 5px 2px 0px, rgba(0, 0, 0, 0.04) 0px 3px 2px 0px, rgba(0, 0, 0, 0.07) 0px 1px 1px 0px, rgba(0, 0, 0, 0.08) 0px 0px 1px 0px`

## Surfaces

- **Pitch Black Canvas** (`#08090a`) — Base page background and deepest surface level.
- **Graphite Card** (`#0f1011`) — Primary card surface for general content, slightly elevated from the canvas.
- **Deep Slate Elevated Card** (`#161718`) — More prominent card surface, used for focused content sections or lists.
- **Charcoal Grey Overlay** (`#23252a`) — Accent surface for borders, shadows, and subtle overlays, providing clear separation.

## Imagery

The site's visual language is dominated by UI elements and product screenshots, emphasizing functionality over decorative imagery. Where images appear, they are often contained within realistic product mockups or embedded application frames. Abstract graphics are minimal, primarily serving as subtle background textures or data visualizations. Icons are filled, minimalist, and mono-color, often adopting the 'Porcelain' (#f7f8f8) or 'Storm Cloud' (#8a8f98) neutral palette, enhancing the dashboard aesthetic. The overall density of imagery is low; it serves an explanatory or product showcase role rather than a decorative one.

## Layout

The page primarily uses a full-bleed structure for background content, with main content sections constrained by a centered maximum width (not explicitly defined but visually present). The hero section features a full-bleed 'Pitch Black' background with a centered, prominent headline. Subsequent sections alternate between dark backgrounds for narrative content and embedded UI examples, often featuring split layouts (text on one side, product UI on the other). Content is generally arranged in vertical stacks or multi-column grids for feature display. Navigation consists of a sticky top bar and frequently observed left-hand sidebar for application-like structures. Spacing is compact yet deliberate, creating a dense but organized information flow.

## Similar Brands

- **Vercel** — Dark UI with strong typography, geometric layouts, and selective use of brand accent colors for interactivity.
- **GitHub** — Emphasis on functional, dark-themed UI for developer tools, prioritizing information density and code readability.
- **Notion (dark mode)** — Layered dark surfaces creating depth, clear typography, and a subdued palette for a productivity application.
- **Raycast** — High-contrast dark mode, minimalist design, and an emphasis on technical tools with clear interaction points.
