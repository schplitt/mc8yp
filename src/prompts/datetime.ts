/**
 * Date/Time Prompts - Help agents work with date ranges and temporal queries
 */

import { definePrompt } from 'tmcp/prompt'
import { prompt } from 'tmcp/utils'

/**
 * Guide for working with dates and time ranges
 */
export function createDateTimeGuidePrompt() {
  return definePrompt({
    name: 'datetime-guide',
    description: 'Learn how to work with dates and time ranges in Cumulocity queries',
  }, () => {
    const now = new Date()
    const currentYear = now.getFullYear()
    const currentMonth = now.getMonth() + 1
    const currentDate = now.getDate()

    return prompt.message(
      `# Working with Dates and Time Ranges

## Current Date/Time
- **Today's Date**: ${now.toISOString().split('T')[0]}
- **Current Time**: ${now.toISOString()}
- **Year**: ${currentYear}
- **Month**: ${currentMonth}
- **Day**: ${currentDate}

## ISO 8601 Format Required
All Cumulocity date parameters MUST use ISO 8601 format:
- **Date only**: \`YYYY-MM-DD\` (e.g., "2024-01-15")
- **Date + Time**: \`YYYY-MM-DDTHH:mm:ss.sssZ\` (e.g., "2024-01-15T14:30:00.000Z")
- **With timezone**: \`YYYY-MM-DDTHH:mm:ss+HH:mm\` (e.g., "2024-01-15T14:30:00+01:00")

## Common Time Ranges

### Relative to Today (${now.toISOString().split('T')[0]})

**Past 24 hours:**
- dateFrom: \`${new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()}\`
- dateTo: \`${now.toISOString()}\`

**Past week (7 days):**
- dateFrom: \`${new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()}\`
- dateTo: \`${now.toISOString()}\`

**Past month (30 days):**
- dateFrom: \`${new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()}\`
- dateTo: \`${now.toISOString()}\`

**Past year:**
- dateFrom: \`${currentYear - 1}-${String(currentMonth).padStart(2, '0')}-${String(currentDate).padStart(2, '0')}T00:00:00.000Z\`
- dateTo: \`${now.toISOString()}\`

**This year (${currentYear}):**
- dateFrom: \`${currentYear}-01-01T00:00:00.000Z\`
- dateTo: \`${now.toISOString()}\`

**Last year (${currentYear - 1}):**
- dateFrom: \`${currentYear - 1}-01-01T00:00:00.000Z\`
- dateTo: \`${currentYear - 1}-12-31T23:59:59.999Z\`

**This month:**
- dateFrom: \`${currentYear}-${String(currentMonth).padStart(2, '0')}-01T00:00:00.000Z\`
- dateTo: \`${now.toISOString()}\`

**Last month:**
- dateFrom: \`${currentYear}-${String(currentMonth === 1 ? 12 : currentMonth - 1).padStart(2, '0')}-01T00:00:00.000Z\`
- dateTo: \`${currentYear}-${String(currentMonth).padStart(2, '0')}-01T00:00:00.000Z\`

## Tools That Require Dates

### Mandatory Date Parameters
- **Audit logs** (\`get-audit\`): Requires at least dateFrom OR dateTo
- **Measurement stats** (\`get-measurement-stats\`): Requires both dateFrom AND dateTo

### Optional But Recommended
- **Events** (\`get-events\`): dateFrom, dateTo
- **Measurements** (\`get-measurements\`): dateFrom, dateTo
- **Alarms** (\`get-alarms\`): dateFrom, dateTo
- **Tenant statistics** (\`get-tenant-stats\`, \`get-tenant-summary\`): dateFrom, dateTo

## User Query Translation

When users say:
- **"today"** → dateFrom: start of today, dateTo: now
- **"yesterday"** → dateFrom: start of yesterday, dateTo: end of yesterday
- **"this week"** → dateFrom: start of current week (Monday), dateTo: now
- **"last week"** → dateFrom: start of previous week, dateTo: end of previous week
- **"this month"** → dateFrom: first day of current month, dateTo: now
- **"last month"** → dateFrom: first day of previous month, dateTo: last day of previous month
- **"this year"** → dateFrom: ${currentYear}-01-01, dateTo: now
- **"last year"** → dateFrom: ${currentYear - 1}-01-01, dateTo: ${currentYear - 1}-12-31
- **"past hour"** → dateFrom: 1 hour ago, dateTo: now
- **"past 24 hours"** → dateFrom: 24 hours ago, dateTo: now
- **"past 7 days"** → dateFrom: 7 days ago, dateTo: now
- **"past 30 days"** → dateFrom: 30 days ago, dateTo: now
- **"past year"** → dateFrom: 365 days ago, dateTo: now

## Calculating Dates in JavaScript

\`\`\`javascript
const now = new Date()

// Past X hours
const hoursAgo = (hours) => new Date(now.getTime() - hours * 60 * 60 * 1000)

// Past X days
const daysAgo = (days) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000)

// Start of today
const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())

// Start of month
const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)

// Start of year
const startOfYear = new Date(now.getFullYear(), 0, 1)

// Convert to ISO
const toISO = (date) => date.toISOString()
\`\`\`

## Best Practices

1. **Always use UTC** unless user specifies timezone
2. **Include time component** for precision (HH:mm:ss.sssZ)
3. **Use dateFrom for "since" queries** (e.g., "events since yesterday")
4. **Use dateTo for "until" queries** (e.g., "alarms until last week")
5. **Use both for range queries** (e.g., "measurements between Jan 1 and Jan 31")
6. **Default to reasonable ranges** - don't query years of data without user intent
7. **For audit logs, always provide at least one date** to avoid errors

## Error Prevention

❌ **Invalid**: \`undefined\` (causes "undefined is not a valid date" error)
❌ **Invalid**: \`"last week"\` (must be ISO format)
❌ **Invalid**: \`"2024/01/15"\` (wrong separator)
✅ **Valid**: \`"2024-01-15"\`
✅ **Valid**: \`"2024-01-15T00:00:00.000Z"\`
`,
    )
  })
}

/**
 * Calculate date ranges for common user queries
 */
export function createCalculateDateRangePrompt() {
  return definePrompt({
    name: 'calculate-date-range',
    description: 'Calculate ISO date range for a user query like "past week" or "last month"',
  }, () => {
    const now = new Date()
    const calculations = {
      past_24_hours: {
        dateFrom: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
        dateTo: now.toISOString(),
      },
      past_week: {
        dateFrom: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(),
        dateTo: now.toISOString(),
      },
      past_month: {
        dateFrom: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(),
        dateTo: now.toISOString(),
      },
      past_year: {
        dateFrom: new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString(),
        dateTo: now.toISOString(),
      },
      today: {
        dateFrom: new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString(),
        dateTo: now.toISOString(),
      },
      this_week: {
        dateFrom: new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay() + 1).toISOString(),
        dateTo: now.toISOString(),
      },
      this_month: {
        dateFrom: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(),
        dateTo: now.toISOString(),
      },
      this_year: {
        dateFrom: new Date(now.getFullYear(), 0, 1).toISOString(),
        dateTo: now.toISOString(),
      },
    }

    return prompt.message(
      `# Pre-calculated Date Ranges

Current time: ${now.toISOString()}

${Object.entries(calculations).map(([key, range]) => `
## ${key.replace(/_/g, ' ').toUpperCase()}
- **dateFrom**: \`${range.dateFrom}\`
- **dateTo**: \`${range.dateTo}\`
`).join('\n')}

Use these exact ISO strings in your tool calls.
`,
    )
  })
}
