# Google Places CLI Workflow

Unix-style interface for discovering places and getting business information.

## Quick Reference

```bash
# Find nearby places by type
kaya-cli places nearby coffee
kaya-cli places nearby restaurant --radius 1000

# Search by name/query
kaya-cli places search "Blue Bottle Coffee"
kaya-cli places search "thai food near me"

# Get hours for a place
kaya-cli places hours ChIJ...

# Get full details
kaya-cli places details ChIJ...

# List available place types
kaya-cli places types
```

## Commands

### nearby
Find places of a specific type near your location.

```bash
kaya-cli places nearby restaurant              # Restaurants within 5km
kaya-cli places nearby cafe --radius 1000      # Cafes within 1km
kaya-cli places nearby gym --limit 5           # Top 5 gyms
kaya-cli places nearby pharmacy --json         # JSON output
kaya-cli places nearby bar --location 37.7749,-122.4194  # Custom location
```

### search
Search for places by name or description.

```bash
kaya-cli places search "Starbucks"             # Find Starbucks locations
kaya-cli places search "best sushi"            # Search query
kaya-cli places search "24 hour pharmacy"      # Specific criteria
kaya-cli places search "Blue Bottle" --json    # JSON for parsing
```

### hours
Get opening hours for a specific place.

```bash
kaya-cli places hours ChIJN1t_tDeuEmsRUsoyG83frY4
kaya-cli places hours ChIJ... --json           # JSON output
```

### details
Get full details including phone, website, reviews.

```bash
kaya-cli places details ChIJN1t_tDeuEmsRUsoyG83frY4
kaya-cli places details ChIJ... --json
```

### types
List all available place types for `nearby` command.

```bash
kaya-cli places types                          # Categorized list
kaya-cli places types --json                   # JSON array
```

## Place Types

### Food & Drink
`restaurant`, `cafe`, `bar`, `bakery`, `meal_takeaway`

### Shopping
`grocery_or_supermarket`, `convenience_store`, `clothing_store`, `electronics_store`, `book_store`, `furniture_store`, `hardware_store`

### Health
`pharmacy`, `hospital`, `doctor`, `gym`, `spa`

### Services
`bank`, `atm`, `post_office`, `laundry`, `hair_care`, `beauty_salon`

### Auto
`gas_station`, `car_repair`, `car_wash`, `parking`

### Entertainment
`movie_theater`, `museum`, `library`, `art_gallery`, `zoo`, `park`

### Travel
`lodging`, `airport`, `train_station`, `bus_station`, `subway_station`

## Pipe Composition

```bash
# Get just names of nearby cafes
kaya-cli places nearby cafe --json | jq -r '.[].name'

# Find open restaurants
kaya-cli places nearby restaurant --json | jq '.[] | select(.opening_hours.open_now == true) | .name'

# Get phone numbers
kaya-cli places search "dentist" --json | jq -r '.[].place_id' | head -3 | while read id; do
  kaya-cli places details "$id" --json | jq -r '.formatted_phone_number // "No phone"'
done

# Sort by rating
kaya-cli places nearby restaurant --json | jq 'sort_by(-.rating) | .[0:5] | .[].name'

# Export to CSV
kaya-cli places nearby cafe --json | jq -r '.[] | [.name, .rating, .vicinity] | @csv'
```

## Options

| Option | Description | Default |
|--------|-------------|---------|
| `--json` | Output as JSON | Human-readable |
| `--location <lat,lng>` | Override location | Auto-detected via IP |
| `--radius <meters>` | Search radius | 5000 |
| `--limit <n>` | Limit results | 20 |

## Authentication

Requires Google Places API key in `~/.claude/secrets.json`:

```json
{
  "GOOGLE_PLACES_API_KEY": "your-api-key-here"
}
```

### Getting an API Key

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create or select a project
3. Enable "Places API" and "Places API (New)"
4. Create credentials → API Key
5. Add to `secrets.json`

## Use Cases

### Quick Discovery
```bash
# What's nearby for lunch?
kaya-cli places nearby restaurant --radius 500

# Find coffee shop that's open
kaya-cli places nearby cafe --json | jq '.[] | select(.opening_hours.open_now) | .name' | head -1
```

### Get Business Info
```bash
# Find a business
kaya-cli places search "Target San Francisco"

# Get their hours
kaya-cli places hours <place_id_from_above>
```

### Location-Based Scripting
```bash
# Check if pharmacy is open
is_open=$(kaya-cli places nearby pharmacy --limit 1 --json | jq '.[0].opening_hours.open_now')
if [ "$is_open" = "true" ]; then
  echo "Pharmacy is open!"
fi
```

## Output Examples

### Human-Readable (default)
```
Nearby restaurant:

1. Golden Gate Grill $$
   ★★★★☆ 4.2 (847)
   123 Main Street
   Open now
   ID: ChIJ...

2. Ocean View Cafe $
   ★★★★★ 4.8 (234)
   456 Beach Blvd
   Closed
   ID: ChIJ...
```

### JSON Output
```json
[
  {
    "place_id": "ChIJ...",
    "name": "Golden Gate Grill",
    "rating": 4.2,
    "user_ratings_total": 847,
    "vicinity": "123 Main Street",
    "price_level": 2,
    "opening_hours": { "open_now": true }
  }
]
```

## Troubleshooting

**API Key Error**
- Verify key in `~/.claude/secrets.json`
- Check key has Places API enabled in Google Cloud Console

**No Results**
- Try larger radius: `--radius 10000`
- Try text search instead: `kaya-cli places search "coffee"`
- Check location is correct: `--location lat,lng`

**Rate Limiting**
- Places API has usage quotas
- Add delays between requests in scripts
- Check quota in Google Cloud Console
