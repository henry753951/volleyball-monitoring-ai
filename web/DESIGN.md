---
name: Broadcast Slate
description: An Apple-disciplined coach surface paired with a dense professional video annotation workstation.
---

<!-- SEED: established with the user before implementation; re-run $impeccable document once there's code to capture the actual tokens and components. -->

# Design System: Broadcast Slate

## Overview

**Creative North Star: "The courtside control surface."** The product should feel like a broadcast replay desk reduced to the controls a coach or annotator actually needs. Coach surfaces use quiet, bright system materials and direct content; the Annotation workstation uses near-black editing surfaces, crisp track geometry and compact transport controls. Both worlds share precise state color, restrained radii and platform-native typography.

The signature is a continuous media rail: score, video, key points and analysis read as synchronized parts of one event rather than separate dashboard cards. Motion is critically damped and source-anchored. Dragged markers track the pointer 1:1; drawers materialize from their trigger and remain interruptible.

**Key Characteristics:**

- Content-first iPad screens with compact translucent chrome.
- A deep graphite PC workstation with one uninterrupted video/timeline composition.
- Signal colors reserved for transport and processing state.
- Dense lists and rails in place of explanatory cards.
- System typography with size-specific tracking and tabular numerals for time and score.

## Colors

Coach surfaces use cool white and pale blue-gray under daylight or arena lighting. Annotation surfaces use neutral graphite so video remains the visual authority. Blue denotes selectable/AI-ready state, green denotes committed mapping or immutable submission, amber denotes active processing/buffering and red is reserved for errors, destructive actions and the playhead.

**The State Has One Color Rule.** A state color keeps the same meaning across list, timeline, badge and control; decoration never borrows it.

## Typography

Use the platform system stack so Chinese and Latin labels retain native metrics on iPad and Windows. Scores and page titles use stronger weight and tighter tracking; body copy stays near zero tracking; timecodes, frame indices and track IDs alone may use a tabular monospace stack.

**The Measurement Type Rule.** Monospace is for time, frame, revision and track identifiers only—not for product personality.

## Layout

Coach screens use one compact top toolbar, a content canvas and a three-destination bottom tab bar in match context. Lists expose score and status at the outer level. Rally replay gives the media/court workspace most of the viewport and moves overlay options into a secondary drawer.

The Annotation workstation uses a thin window-style toolbar, a video workspace with a fixed but resizable-feeling inspector, a transport row, buffer rail, editable timeline and compact command deck. No nested card grid is used inside the editor.

**The One Working Plane Rule.** Video, transport and timeline share a single aligned horizontal coordinate system wherever time is represented.

## Elevation & Depth

Coach chrome floats using translucent material and a soft offset shadow only where content passes underneath. Content surfaces are primarily separated by tone and spacing. Annotation depth is tonal: video black, editor graphite, inspector charcoal and floating popovers one step lighter.

**The Chrome Floats, Content Does Not Rule.** Shadows belong to toolbars, drawers and transient surfaces; ordinary rows stay flat.

## Shapes

Large product surfaces use gently continuous 14–18px corners on iPad. Compact PC controls use 6–9px corners. Pills are limited to short status badges and segmented controls. Timeline masks stay low-radius so duration remains visually measurable.

## Do's and Don'ts

### Do:

- **Do** lead with score, video, time and actionable analysis.
- **Do** keep advanced overlay and connection detail one level deeper.
- **Do** make every selected marker, mask and mapping row visibly actionable.
- **Do** use direct Chinese product language such as「回合」「球員」「現場」.
- **Do** preserve server-authoritative time and external `court_pos` exactly.

### Don't:

- **Don't** show architecture, immutability, schema, revision or implementation explanations as ordinary product copy.
- **Don't** repeat page titles, subtitles or navigation destinations in the content body.
- **Don't** build the coach surface from equal-sized dashboard cards.
- **Don't** expose Annotation preferences in the coach PWA.
- **Don't** use decorative glass, colored glows or large empty headers.
