# Coding Project Overlay

> *Apply this overlay to Current Work specs for implementation/development tasks*

---

## A. Technical Stack

### Language & Framework

```yaml
language:
  primary: {{LANGUAGE}}
  version: {{VERSION}}
  strict_mode: {{true|false}}

framework:
  name: {{FRAMEWORK_NAME}}
  version: {{VERSION}}

runtime:
  environment: {{NODE|BUN|DENO|PYTHON|etc.}}
  version: {{VERSION}}
```

### Dependencies

**Required:**
| Package | Version | Purpose |
|---------|---------|---------|
| {{PACKAGE_1}} | {{VERSION}} | {{PURPOSE}} |
| {{PACKAGE_2}} | {{VERSION}} | {{PURPOSE}} |
| {{PACKAGE_3}} | {{VERSION}} | {{PURPOSE}} |

**Dev Dependencies:**
| Package | Version | Purpose |
|---------|---------|---------|
| {{DEV_PACKAGE_1}} | {{VERSION}} | {{PURPOSE}} |
| {{DEV_PACKAGE_2}} | {{VERSION}} | {{PURPOSE}} |

**Prohibited (Do Not Use):**
| Package | Reason |
|---------|--------|
| {{PACKAGE}} | {{WHY_PROHIBITED}} |

---

## B. Code Quality Standards

### Type Safety

```yaml
typescript:
  strict: true
  noImplicitAny: true
  strictNullChecks: true
  noUncheckedIndexedAccess: true

type_requirements:
  - All function parameters must be typed
  - All return types must be explicit
  - No 'any' except with explicit justification
  - Prefer interfaces over type aliases for objects
```

### Test Coverage

| Coverage Type | Target | Enforcement |
|---------------|--------|-------------|
| Line Coverage | ≥{{PERCENTAGE}}% | {{BLOCKING|WARNING}} |
| Branch Coverage | ≥{{PERCENTAGE}}% | {{ENFORCEMENT}} |
| Function Coverage | ≥{{PERCENTAGE}}% | {{ENFORCEMENT}} |

**Test Requirements:**
- [ ] Unit tests for all business logic
- [ ] Integration tests for API endpoints
- [ ] Edge case coverage documented
- [ ] No skipped tests without issue link

### Linting & Formatting

```yaml
linter:
  tool: {{ESLINT|BIOME|etc.}}
  config: {{CONFIG_LOCATION}}
  errors_block_commit: true

formatter:
  tool: {{PRETTIER|BIOME|etc.}}
  config: {{CONFIG_LOCATION}}

pre_commit:
  - lint
  - format
  - type-check
  - test
```

### Code Style Guidelines

**Naming Conventions:**
| Element | Convention | Example |
|---------|------------|---------|
| Variables | camelCase | `userName` |
| Functions | camelCase | `getUserById` |
| Classes | PascalCase | `UserService` |
| Constants | SCREAMING_SNAKE | `MAX_RETRIES` |
| Files | kebab-case | `user-service.ts` |
| Interfaces | PascalCase with I prefix (optional) | `IUserService` or `UserService` |

**Structural Guidelines:**
- Max file length: {{LINES}} lines
- Max function length: {{LINES}} lines
- Max nesting depth: {{DEPTH}} levels
- Single responsibility per function/class
- Prefer composition over inheritance

---

## C. PR Requirements

### PR Template

```markdown
## Summary
{{BRIEF_DESCRIPTION}}

## Type of Change
- [ ] Bug fix (non-breaking change fixing an issue)
- [ ] New feature (non-breaking change adding functionality)
- [ ] Breaking change (fix or feature causing existing functionality to change)
- [ ] Refactor (no functional changes)
- [ ] Documentation update

## Related Issues
Closes #{{ISSUE_NUMBER}}

## Changes Made
- {{CHANGE_1}}
- {{CHANGE_2}}
- {{CHANGE_3}}

## Testing
- [ ] Unit tests added/updated
- [ ] Integration tests added/updated
- [ ] Manual testing completed

## Screenshots (if applicable)
{{SCREENSHOTS}}

## Checklist
- [ ] Code follows style guidelines
- [ ] Self-review completed
- [ ] Comments added for complex logic
- [ ] Documentation updated
- [ ] No new warnings introduced
- [ ] Tests pass locally
```

### Review Requirements

| PR Size | Reviewers Required | Max Review Time |
|---------|-------------------|-----------------|
| Small (<100 lines) | 1 | {{TIME}} |
| Medium (100-500 lines) | 2 | {{TIME}} |
| Large (>500 lines) | 2+ | {{TIME}} |

**Review Checklist:**
- [ ] Code correctness
- [ ] Test coverage adequate
- [ ] No security vulnerabilities
- [ ] Performance implications considered
- [ ] Error handling appropriate
- [ ] Documentation updated

### Merge Requirements

- [ ] All CI checks pass
- [ ] Required approvals received
- [ ] No unresolved conversations
- [ ] Branch up to date with base
- [ ] Squash commits if >3 commits

---

## D. Architecture Guidelines

### File Structure

```
src/
├── {{MODULE_1}}/
│   ├── __tests__/
│   │   └── {{FILE}}.test.ts
│   ├── {{FILE}}.ts
│   └── index.ts
├── {{MODULE_2}}/
│   └── ...
├── shared/
│   ├── types/
│   ├── utils/
│   └── constants/
└── index.ts
```

### Import Order

```typescript
// 1. External dependencies
import { something } from 'external-package';

// 2. Internal absolute imports
import { util } from '@/shared/utils';

// 3. Relative imports
import { local } from './local';

// 4. Type imports (last)
import type { SomeType } from './types';
```

### Error Handling Pattern

```typescript
// Preferred: Result type
type Result<T, E = Error> =
  | { success: true; data: T }
  | { success: false; error: E };

// Usage
function doSomething(): Result<Data> {
  try {
    const data = riskyOperation();
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error as Error };
  }
}
```

---

## E. CI/CD Integration

### Pipeline Stages

```yaml
stages:
  - name: lint
    command: {{LINT_COMMAND}}
    blocking: true

  - name: type-check
    command: {{TYPE_CHECK_COMMAND}}
    blocking: true

  - name: test
    command: {{TEST_COMMAND}}
    blocking: true
    coverage_threshold: {{PERCENTAGE}}%

  - name: build
    command: {{BUILD_COMMAND}}
    blocking: true

  - name: security-scan
    command: {{SCAN_COMMAND}}
    blocking: {{true|false}}
```

### Environment Variables

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `{{VAR_1}}` | {{DESCRIPTION}} | {{YES|NO}} | {{DEFAULT}} |
| `{{VAR_2}}` | {{DESCRIPTION}} | {{YES|NO}} | {{DEFAULT}} |

**Secrets (Never Commit):**
- `{{SECRET_1}}` - {{DESCRIPTION}}
- `{{SECRET_2}}` - {{DESCRIPTION}}

---

## F. Documentation Requirements

### Code Documentation

| Element | Documentation Required |
|---------|----------------------|
| Public functions | JSDoc with params, returns, throws |
| Public classes | Class-level JSDoc |
| Complex logic | Inline comments explaining why |
| Workarounds | Comment with issue link |
| TODO items | TODO(username): description |

### README Updates

When to update README:
- [ ] New environment variable added
- [ ] New dependency with setup steps
- [ ] API changes
- [ ] Configuration changes
- [ ] New scripts added

---

## G. Performance Considerations

### Targets

| Metric | Target | Measurement |
|--------|--------|-------------|
| Bundle size | <{{SIZE}}KB | {{HOW_MEASURED}} |
| Load time | <{{TIME}}s | {{HOW_MEASURED}} |
| API response | <{{TIME}}ms P95 | {{HOW_MEASURED}} |
| Memory usage | <{{SIZE}}MB | {{HOW_MEASURED}} |

### Anti-Patterns to Avoid

- [ ] Unbounded loops without limits
- [ ] N+1 queries
- [ ] Synchronous blocking in async context
- [ ] Large objects in memory
- [ ] Missing pagination for lists
- [ ] Unnecessary re-renders (if applicable)

---

*This overlay extends the Current Work spec with coding-specific standards. Apply by filling in the placeholders above and appending to Section 8 of the Current Work template.*
