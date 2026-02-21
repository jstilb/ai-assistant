# State/ -- Runtime State Directory

> This directory stores runtime state data for this skill and is excluded
> from the public repository. It is auto-populated during normal operation.

## Purpose

State files persist data between sessions for this skill. They are managed
by the StateManager utility (`skills/CORE/Tools/StateManager.ts`).

## Setup

This directory is created automatically when the skill first runs. No
manual setup is required. If you need to reset the skill's state, simply
delete the contents of this directory.
