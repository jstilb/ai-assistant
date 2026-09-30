# Weather Workflow

Weather information via wttr.in (zero dependencies, no API key required).

## Prerequisites

- Bun runtime installed
- Internet connection

## Quick Start

```bash
# Current location weather
kaya-cli weather

# Specific city
kaya-cli weather "San Francisco"

# 3-day forecast
kaya-cli weather --forecast

# JSON output
kaya-cli weather --json
```

## Commands

| Command | Description |
|---------|-------------|
| `kaya-cli weather` | Current conditions (auto-detect location) |
| `kaya-cli weather "City"` | Weather for specific city |
| `kaya-cli weather --forecast` | 3-day forecast |

## Options

| Option | Short | Description |
|--------|-------|-------------|
| `--forecast` | `-f` | Show 3-day forecast |
| `--json` | `-j` | Output as JSON |
| `--imperial` | `-i` | Use Fahrenheit |
| `--metric` | `-m` | Use Celsius (default) |
| `--oneline` | `-1` | Compact one-line output |
| `--quiet` | `-q` | Minimal output (temp only) |

## Examples

### Current Conditions

```bash
# Auto-detect location
kaya-cli weather

# Output:
# 📍 San Francisco, United States
# 🌡️  Temperature: 18°C (feels like 17°C)
# ☁️  Conditions: Partly cloudy
# 💨 Wind: 15 km/h W
# 💧 Humidity: 72%
# 👁️  Visibility: 10 km
# ☀️  UV Index: 3
```

### 3-Day Forecast

```bash
kaya-cli weather "New York" --forecast

# Output:
# 📍 New York, United States - 3-Day Forecast
#
# 📅 Wednesday, Jan 29
#    High: 5°C / Low: -2°C
#    Partly cloudy
#
# 📅 Thursday, Jan 30
#    High: 8°C / Low: 1°C
#    Overcast
#    🌧️  45% chance of rain
```

### Compact Output

```bash
# One-liner
kaya-cli weather --oneline
# San Francisco: +18°C Partly cloudy ↘15km/h

# Temperature only
kaya-cli weather --quiet
# +18°C
```

### Imperial Units

```bash
kaya-cli weather "London" --imperial

# Shows Fahrenheit and mph
```

### JSON for Scripts

```bash
# Full JSON data
kaya-cli weather "Tokyo" --json | jq '.current_condition[0].temp_C'

# Get current temperature
temp=$(kaya-cli weather --json | jq -r '.current_condition[0].temp_C')
echo "Current: ${temp}°C"
```

## Integration Examples

### Daily Weather Report

```bash
#!/bin/bash
# morning-weather.sh
echo "Good morning! Here's today's weather:"
echo ""
kaya-cli weather --forecast | head -15
```

### Weather in Prompt

```bash
# Add to shell prompt
weather_emoji() {
    local temp=$(kaya-cli weather --quiet 2>/dev/null | tr -d '+°C')
    if [[ -z "$temp" ]]; then
        echo "❓"
    elif (( temp < 0 )); then
        echo "🥶"
    elif (( temp < 15 )); then
        echo "❄️"
    elif (( temp < 25 )); then
        echo "☀️"
    else
        echo "🔥"
    fi
}
```

### Raycast Script

```bash
#!/bin/bash
# @raycast.schemaVersion 1
# @raycast.title Weather
# @raycast.mode inline
# @raycast.refreshTime 30m

kaya-cli weather --oneline
```

### Notification on Rain

```bash
#!/bin/bash
rain_chance=$(kaya-cli weather --json | jq -r '.weather[0].hourly[8].chanceofrain')
if (( rain_chance > 50 )); then
    echo "🌧️ $rain_chance% chance of rain today - bring an umbrella!"
fi
```

## API Details

**Data source:** [wttr.in](https://wttr.in)

- Free, no API key required
- Rate limited (soft limit)
- Supports 60,000+ locations
- Auto-detects location via IP

## Output Formats

| Format | Description |
|--------|-------------|
| Default | Formatted with emojis |
| `--json` | Full JSON data |
| `--oneline` | Compact single line |
| `--quiet` | Temperature only |

## Error Handling

```bash
# Check for errors
if ! weather=$(kaya-cli weather --json 2>/dev/null); then
    echo "Could not fetch weather"
    exit 1
fi
```

Common errors:
- **Network error**: Check internet connection
- **Location not found**: Try more specific location
- **Rate limited**: Wait and retry

## Performance

- Initial fetch: < 1s
- Cached: N/A (real-time)
- No local storage

## Documentation

- wttr.in: https://github.com/chubin/wttr.in
- Weather.ts source: `~/.claude/tools/UnixCLI/Weather.ts`
