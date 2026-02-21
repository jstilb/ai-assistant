# UpdateContainer Workflow

> **Trigger:** User requests a single container update (e.g., "refresh the weather", "update tasks")
> **Owner:** ContainerBuilder
> **Priority:** P2

---

## Purpose

Update a single container within an existing layout without rebuilding the entire layout. Identifies the target container, fetches fresh data, and updates only that container.

---

## Steps

### 1. Identify Target Container
- Parse user request for container reference
- Match against current layout containers by:
  - Container type (e.g., "weather" -> type: "weather")
  - Container title (e.g., "tasks" -> title contains "tasks")
  - Container ID (direct reference)
- If ambiguous (multiple matches), ask user for clarification

### 2. Fetch Fresh Data
- Read container's `dataSource` to determine how to refresh
- `briefing-block` -> Re-run the specific BriefingGenerator block
- `api` -> Re-fetch from the API endpoint
- `file` -> Re-read the file
- `inline` -> No automatic refresh available

### 3. Negotiate New Content Type
- Run `negotiateContainerType()` on fresh data
- If the negotiated type differs from current, log but keep current type
  (type changes require explicit user action)

### 4. Update Container
- Send update via `CanvasClient.updateContainer(id, { props: newProps })`
- Do NOT change position or size (preserve user's arrangement)

### 5. Confirm
- Silent operation (no voice notification for single updates)
- Log update to debug channel

---

## Error Handling

| Error | Recovery |
|-------|----------|
| Container not found | Ask user to clarify which container |
| Data source unavailable | Show error state in container |
| Multiple matches | Present options and ask user to pick |

---

## Example

```
Input:   "refresh the weather"
Target:  Container { id: "weather-1", type: "weather" }
Action:  Re-fetch weather data, update props
Output:  Updated container in-place
```
