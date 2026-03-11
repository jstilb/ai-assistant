---
name: ComponentPatterns
description: Common shadcn/ui composition patterns and TypeScript conventions
---
# Component Patterns

Practical composition patterns using shadcn/ui primitives.

## Pattern 1: Card with Header/Content/Footer

```typescript
"use client"

import { cn } from "@/lib/utils"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"

interface UserCardProps {
  name: string
  email: string
  role: string
  onEdit?: () => void
  className?: string
}

export function UserCard({ name, email, role, onEdit, className }: UserCardProps) {
  return (
    <Card className={cn("w-full", className)}>
      <CardHeader>
        <CardTitle>{name}</CardTitle>
        <CardDescription>{role}</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">{email}</p>
      </CardContent>
      <CardFooter className="flex justify-end">
        <Button variant="outline" onClick={onEdit}>
          Edit Profile
        </Button>
      </CardFooter>
    </Card>
  )
}
```

**shadcn components:** `card`, `button`

## Pattern 2: Form with Validation

```typescript
"use client"

import { cn } from "@/lib/utils"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

interface LoginFormProps {
  onSubmit: (email: string, password: string) => Promise<void>
  className?: string
}

export function LoginForm({ onSubmit, className }: LoginFormProps) {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [isLoading, setIsLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsLoading(true)
    try {
      await onSubmit(email, password)
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <Card className={cn("w-full max-w-md", className)}>
      <CardHeader>
        <CardTitle>Sign In</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <Button type="submit" className="w-full" disabled={isLoading}>
            {isLoading ? "Signing in..." : "Sign In"}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
```

**shadcn components:** `card`, `button`, `input`, `label`

## Pattern 3: Dashboard Layout

```typescript
import { cn } from "@/lib/utils"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

interface DashboardLayoutProps {
  stats: Array<{ label: string; value: string | number }>
  children: React.ReactNode
  className?: string
}

export function DashboardLayout({ stats, children, className }: DashboardLayoutProps) {
  return (
    <div className={cn("space-y-8", className)}>
      {/* Stats Grid */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => (
          <Card key={stat.label}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">{stat.label}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stat.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Main Content */}
      <div className="space-y-4">{children}</div>
    </div>
  )
}
```

**shadcn components:** `card`

## Pattern 4: Data Table

```typescript
"use client"

import { cn } from "@/lib/utils"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"

interface User {
  id: string
  name: string
  email: string
  status: "active" | "inactive"
}

interface UserTableProps {
  users: User[]
  className?: string
}

export function UserTable({ users, className }: UserTableProps) {
  return (
    <div className={cn("rounded-md border", className)}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Email</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.length === 0 ? (
            <TableRow>
              <TableCell colSpan={3} className="h-24 text-center">
                No users found.
              </TableCell>
            </TableRow>
          ) : (
            users.map((user) => (
              <TableRow key={user.id}>
                <TableCell className="font-medium">{user.name}</TableCell>
                <TableCell>{user.email}</TableCell>
                <TableCell>
                  <Badge variant={user.status === "active" ? "default" : "secondary"}>
                    {user.status}
                  </Badge>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  )
}
```

**shadcn components:** `table`, `badge`

## Pattern 5: Modal Dialog

```typescript
"use client"

import { cn } from "@/lib/utils"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"

interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  onConfirm: () => void
  confirmText?: string
  cancelText?: string
  variant?: "default" | "destructive"
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  onConfirm,
  confirmText = "Confirm",
  cancelText = "Cancel",
  variant = "default",
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {cancelText}
          </Button>
          <Button variant={variant} onClick={onConfirm}>
            {confirmText}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

**shadcn components:** `dialog`, `button`

## Pattern 6: Tabs Navigation

```typescript
"use client"

import { cn } from "@/lib/utils"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

interface SettingsTabsProps {
  className?: string
}

export function SettingsTabs({ className }: SettingsTabsProps) {
  return (
    <Tabs defaultValue="general" className={cn("w-full", className)}>
      <TabsList className="grid w-full grid-cols-3">
        <TabsTrigger value="general">General</TabsTrigger>
        <TabsTrigger value="security">Security</TabsTrigger>
        <TabsTrigger value="notifications">Notifications</TabsTrigger>
      </TabsList>
      <TabsContent value="general">
        <Card>
          <CardHeader>
            <CardTitle>General Settings</CardTitle>
            <CardDescription>Manage your account preferences</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {/* General settings content */}
          </CardContent>
        </Card>
      </TabsContent>
      <TabsContent value="security">
        <Card>
          <CardHeader>
            <CardTitle>Security Settings</CardTitle>
            <CardDescription>Manage your security preferences</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {/* Security settings content */}
          </CardContent>
        </Card>
      </TabsContent>
      <TabsContent value="notifications">
        <Card>
          <CardHeader>
            <CardTitle>Notification Settings</CardTitle>
            <CardDescription>Choose what you want to be notified about</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {/* Notification settings content */}
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
  )
}
```

**shadcn components:** `tabs`, `card`

## Pattern 7: Dropdown Menu

```typescript
"use client"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { MoreHorizontal } from "lucide-react"

interface ActionsMenuProps {
  onEdit: () => void
  onDelete: () => void
  onDuplicate: () => void
}

export function ActionsMenu({ onEdit, onDelete, onDuplicate }: ActionsMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon">
          <MoreHorizontal className="h-4 w-4" />
          <span className="sr-only">Actions</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Actions</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onEdit}>Edit</DropdownMenuItem>
        <DropdownMenuItem onClick={onDuplicate}>Duplicate</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onDelete} className="text-destructive">
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
```

**shadcn components:** `dropdown-menu`, `button`

## TypeScript Conventions

### Proper Interfaces
```typescript
// ✅ CORRECT - explicit interface
interface ComponentProps {
  title: string
  description?: string
  onAction: () => void
  className?: string
}

// ❌ WRONG - inline types
export function Component(props: {
  title: string
  description?: string
  onAction: () => void
}) { }
```

### Event Handlers
```typescript
// ✅ CORRECT - typed handlers
const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
  e.preventDefault()
  // ...
}

const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
  e.preventDefault()
  // ...
}

// ❌ WRONG - any type
const handleClick = (e: any) => { }
```

### Children Types
```typescript
// ✅ CORRECT
interface LayoutProps {
  children: React.ReactNode
}

// ❌ WRONG
interface LayoutProps {
  children: any
}
```

### Discriminated Unions
```typescript
// ✅ CORRECT - type-safe variants
type ButtonVariant = "default" | "destructive" | "outline" | "ghost"

interface ButtonProps {
  variant?: ButtonVariant
}

// ❌ WRONG - string allows any value
interface ButtonProps {
  variant?: string
}
```

## cn() Usage Patterns

### Base Classes + Override
```typescript
<Card className={cn(
  "p-6",           // Base padding
  "shadow-sm",     // Base shadow
  className        // Allow override
)} />
```

### Conditional Classes
```typescript
<Button className={cn(
  "px-4 py-2",
  isLoading && "opacity-50 cursor-not-allowed",
  isPrimary ? "bg-primary" : "bg-secondary"
)} />
```

### Responsive Classes
```typescript
<div className={cn(
  "grid gap-4",
  "grid-cols-1 md:grid-cols-2 lg:grid-cols-3"
)} />
```

## Common Imports

```typescript
// Always import cn
import { cn } from "@/lib/utils"

// Import only what you use
import { Card, CardContent, CardHeader } from "@/components/ui/card"

// Type imports
import type { ButtonProps } from "@/components/ui/button"
```

## Accessibility Patterns

### Screen Reader Text
```typescript
<Button>
  <Icon className="h-4 w-4" />
  <span className="sr-only">Close dialog</span>
</Button>
```

### ARIA Labels
```typescript
<button aria-label="Close" onClick={onClose}>
  <X className="h-4 w-4" />
</button>
```

### Keyboard Navigation
```typescript
<div
  role="button"
  tabIndex={0}
  onClick={handleClick}
  onKeyDown={(e) => {
    if (e.key === "Enter" || e.key === " ") {
      handleClick()
    }
  }}
>
  Clickable div
</div>
```

---

**Last Updated:** 2026-02-13
