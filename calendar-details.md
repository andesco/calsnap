# 📋 TeamSnap Calendar Template Guide

## Quick Start

**Edit Location**: `index.js` at approx. line 200
**Test**: Add `?debug=true&cache=off` to calendar URL

## Reference Files

- **`teamsnap-event-fields.csv`** - 47 available fields with sample data
- **`teamsnap-location-fields.csv`** — location API reference

## Current Implementation

**One simple function** with `if/else` logic based on event type:

### **Function**: `generateEventDescription()`

#### **Games** `event.is_game = true`

**Output Example:**
```
Away vs. Forest Hill
Arrival: 5:20 PM · 40 min. early
Venue: Rinx · Rink 2
Uniform: White
Notes: Bring water bottles
```

**Fields Used:**
- `event.label` + `event.game_type` + `event.opponent_name`
- `event.arrival_date` + `event.minutes_to_arrive_early`
- `event.location_name` + `event.additional_location_details`
- `event.uniform` + `event.notes`

#### **Non-Games** `event.is_game = false`
**Output Example:**
```
Practice
Location: Rinx
Notes: Skills focus tonight
```

**Fields Used:**
- `event.label` (Practice, Meeting, Social, etc.)
- `event.location_name`
- `event.uniform` + `event.notes`

## Customization

```javascript
const generateEventDescription = (event) => {
  let desc = '';

  if (event.is_game) {
    // CUSTOMIZE GAME EVENTS HERE:
    if (event.opponent_name) {
      desc += `${event.label || 'Game'} ${event.game_type || ''} vs. ${event.opponent_name}\\n`;
    }
    // Add/remove fields as needed for games

  } else {
    // CUSTOMIZE NON-GAME EVENTS HERE:
    desc += `${event.label || 'Event'}\\n`;
    // Add/remove fields as needed for practices/meetings/etc.
  }

  return desc;
};
```

### **JavaScript Syntax Rules**
```javascript
// Correct · Escaped:
if (event.uniform) desc += `Uniform: ${event.uniform}\\n`;

// Wrong · Missing Escape:
if (event.uniform) desc += `Uniform: ${event.uniform}\n`;

// Correct · Commna Escaped:
desc += `Location: Arena\\, Rink 1`;

// Wrong · Commna Not Escaped · Breaks ICS:
desc += `Location: Arena, Rink 1`;
```

#### **1. Template Function Must Return String**
```javascript
// ❌ RETURNS UNDEFINED - Will break event generation
generateGameDescription: (event) => {
  if (event.uniform) {
    return `Uniform: ${event.uniform}`;
  }
  // Missing return for other cases - returns undefined!
}

// ✅ CORRECT - Always returns string
generateGameDescription: (event) => {
  let desc = '';
  if (event.uniform) desc += `Uniform: ${event.uniform}`;
  return desc;  // Always returns string (even if empty)
}
```

#### **2. Field Availability Check**
```javascript
// ❌ WILL CAUSE "undefined" IN OUTPUT
desc += `Opponent: ${event.opponent_name}\\n`;  // opponent_name might be null

// ✅ SAFE - Always check first
if (event.opponent_name) {
  desc += `Opponent: ${event.opponent_name}\\n`;
}
```

## **Available Event Fields**

**Reference**: See `teamsnap-event-fields.csv` for complete list of 47 fields

**Most Useful Fields:**
- `event.opponent_name` - "Forest Hill"
- `event.game_type` - "Away" / "Home"
- `event.is_game` - true/false
- `event.label` - "Exhibition" / "Practice" / "Meeting"
- `event.uniform` - "White"
- `event.arrival_date` - ISO timestamp
- `event.minutes_to_arrive_early` - 30
- `event.location_name` - "Rinx"
- `event.additional_location_details` - "Rink 2"
- `event.notes` - Free text notes

## **Testing Workflow**

1. Deploy Changes
```bash
npx wrangler deploy
```

2. Clear Cache & Test with Cache Bypass
```bash
npx wrangler kv key delete calendar_ID --binding {KV namespace} --remote
curl "https://{domain}/calendar.ics?debug=true&cache=off"
```

3. Monitor Logs
```bash
npx wrangler tail
```
