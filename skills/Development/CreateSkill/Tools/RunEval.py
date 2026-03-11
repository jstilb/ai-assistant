#!/usr/bin/env python3
"""Run trigger evaluation for a skill description.

Tests whether a skill's description causes Claude to trigger (read the skill)
for a set of queries. Outputs results as JSON.
"""

import argparse
import json
import os
import select
import subprocess
import sys
import time
import uuid
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import sys; sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent))
from Utils import parse_skill_md


def find_project_root() -> Path:
    """Return user home so temp commands go to ~/.claude/commands/.

    Hardcoded to avoid CWD-dependent discovery that breaks when CWD
    is ~/.claude (finds nested ~/.claude/.claude/ instead).
    """
    return Path.home()


def run_single_query(
    query: str,
    skill_name: str,
    skill_description: str,
    timeout: int,
    project_root: str,
    model: str | None = None,
    parent_names: list[str] | None = None,
) -> bool:
    """Run a single query and return whether the skill was triggered.

    Creates a command file in .claude/commands/ so it appears in Claude's
    available_skills list, then runs `claude -p` with the raw query.
    Uses --include-partial-messages to detect triggering early from
    stream events (content_block_start) rather than waiting for the
    full assistant message, which only arrives after tool execution.
    """
    unique_id = uuid.uuid4().hex[:8]
    clean_name = f"{skill_name}-skill-{unique_id}"
    # Match on temp command name OR parent skill names (e.g., "Commerce" for JobEngine)
    match_names = {clean_name}
    if parent_names:
        match_names.update(parent_names)
    project_commands_dir = Path(project_root) / ".claude" / "commands"
    command_file = project_commands_dir / f"{clean_name}.md"

    try:
        project_commands_dir.mkdir(parents=True, exist_ok=True)
        # Use YAML block scalar to avoid breaking on quotes in description
        indented_desc = "\n  ".join(skill_description.split("\n"))
        command_content = (
            f"---\n"
            f"description: |\n"
            f"  {indented_desc}\n"
            f"---\n\n"
            f"# {skill_name}\n\n"
            f"This skill handles: {skill_description}\n"
        )
        command_file.write_text(command_content)

        cmd = [
            "claude",
            "-p", query,
            "--output-format", "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--permission-mode", "bypassPermissions",
        ]
        if model:
            cmd.extend(["--model", model])

        # Remove CLAUDECODE env var to allow nesting claude -p inside a
        # Claude Code session. The guard is for interactive terminal conflicts;
        # programmatic subprocess usage is safe.
        env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}

        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            cwd=project_root,
            env=env,
        )

        triggered = False
        start_time = time.time()
        buffer = ""
        # Track state for stream event detection
        state = {"pending_tool_name": None, "accumulated_json": ""}

        def parse_line(line: str) -> bool | None:
            """Parse a single JSON line. Returns True/False for definitive result, None to continue."""
            nonlocal triggered
            line = line.strip()
            if not line:
                return None
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                return None

            # Early detection via stream events
            if event.get("type") == "stream_event":
                se = event.get("event", {})
                se_type = se.get("type", "")

                if se_type == "content_block_start":
                    cb = se.get("content_block", {})
                    if cb.get("type") == "tool_use":
                        tool_name = cb.get("name", "")
                        if tool_name in ("Skill", "Read"):
                            state["pending_tool_name"] = tool_name
                            state["accumulated_json"] = ""
                        # else: continue scanning — don't exit early

                elif se_type == "content_block_delta" and state["pending_tool_name"]:
                    delta = se.get("delta", {})
                    if delta.get("type") == "input_json_delta":
                        state["accumulated_json"] += delta.get("partial_json", "")
                        if any(n in state["accumulated_json"] for n in match_names):
                            return True

                elif se_type == "content_block_stop":
                    if state["pending_tool_name"] and any(n in state["accumulated_json"] for n in match_names):
                        return True
                    state["pending_tool_name"] = None
                    state["accumulated_json"] = ""

                elif se_type == "message_stop":
                    return triggered

            # Fallback: full assistant message
            elif event.get("type") == "assistant":
                message = event.get("message", {})
                has_tool_use = False
                for content_item in message.get("content", []):
                    if content_item.get("type") != "tool_use":
                        continue
                    has_tool_use = True
                    tool_name = content_item.get("name", "")
                    tool_input = content_item.get("input", {})
                    skill_val = tool_input.get("skill", "")
                    file_val = tool_input.get("file_path", "")
                    if tool_name == "Skill" and any(n in skill_val for n in match_names):
                        triggered = True
                    elif tool_name == "Read" and any(n in file_val for n in match_names):
                        triggered = True
                if has_tool_use:
                    return triggered

            elif event.get("type") == "result":
                return triggered

            return None

        def drain_buffer() -> bool | None:
            """Parse all complete lines in buffer. Returns True/False if definitive, None otherwise."""
            nonlocal buffer
            while "\n" in buffer:
                line, buffer = buffer.split("\n", 1)
                result = parse_line(line)
                if result is not None:
                    return result
            return None

        try:
            while time.time() - start_time < timeout:
                if process.poll() is not None:
                    remaining = process.stdout.read()
                    if remaining:
                        buffer += remaining.decode("utf-8", errors="replace")
                    break

                ready, _, _ = select.select([process.stdout], [], [], 1.0)
                if not ready:
                    continue

                chunk = os.read(process.stdout.fileno(), 8192)
                if not chunk:
                    break
                buffer += chunk.decode("utf-8", errors="replace")

                result = drain_buffer()
                if result is not None:
                    return result

            # Parse any remaining buffered data after process exit or timeout
            result = drain_buffer()
            if result is not None:
                return result

        finally:
            # Clean up process on any exit path (return, exception, timeout)
            if process.poll() is None:
                process.kill()
                process.wait()

        return triggered
    finally:
        if command_file.exists():
            command_file.unlink()


def run_eval(
    eval_set: list[dict],
    skill_name: str,
    description: str,
    num_workers: int,
    timeout: int,
    project_root: Path,
    runs_per_query: int = 1,
    trigger_threshold: float = 0.5,
    model: str | None = None,
    parent_names: list[str] | None = None,
) -> dict:
    """Run the full eval set and return results."""
    # Clean up stale temp command files from previous runs (killed processes
    # may leave files behind, causing claude -p to see duplicate skills)
    commands_dir = Path(project_root) / ".claude" / "commands"
    if commands_dir.exists():
        for f in commands_dir.glob("*-skill-*.md"):
            try:
                f.unlink()
            except OSError:
                pass

    results = []

    with ProcessPoolExecutor(max_workers=num_workers) as executor:
        future_to_info = {}
        for item in eval_set:
            for run_idx in range(runs_per_query):
                future = executor.submit(
                    run_single_query,
                    item["query"],
                    skill_name,
                    description,
                    timeout,
                    str(project_root),
                    model,
                    parent_names,
                )
                future_to_info[future] = (item, run_idx)

        query_triggers: dict[str, list[bool]] = {}
        query_items: dict[str, dict] = {}
        for future in as_completed(future_to_info):
            item, _ = future_to_info[future]
            query = item["query"]
            query_items[query] = item
            if query not in query_triggers:
                query_triggers[query] = []
            try:
                query_triggers[query].append(future.result())
            except Exception as e:
                print(f"Warning: query failed: {e}", file=sys.stderr)
                query_triggers[query].append(False)

    for query, triggers in query_triggers.items():
        item = query_items[query]
        trigger_rate = sum(triggers) / len(triggers)
        should_trigger = item["should_trigger"]
        if should_trigger:
            did_pass = trigger_rate >= trigger_threshold
        else:
            did_pass = trigger_rate < trigger_threshold
        results.append({
            "query": query,
            "should_trigger": should_trigger,
            "trigger_rate": trigger_rate,
            "triggers": sum(triggers),
            "runs": len(triggers),
            "pass": did_pass,
        })

    passed = sum(1 for r in results if r["pass"])
    total = len(results)

    return {
        "skill_name": skill_name,
        "description": description,
        "results": results,
        "summary": {
            "total": total,
            "passed": passed,
            "failed": total - passed,
        },
    }


def main():
    parser = argparse.ArgumentParser(description="Run trigger evaluation for a skill description")
    parser.add_argument("--eval-set", required=True, help="Path to eval set JSON file")
    parser.add_argument("--skill-path", required=True, help="Path to skill directory")
    parser.add_argument("--description", default=None, help="Override description to test")
    parser.add_argument("--num-workers", type=int, default=2, help="Number of parallel workers (max 2 — higher causes false negatives)")
    parser.add_argument("--timeout", type=int, default=30, help="Timeout per query in seconds")
    parser.add_argument("--runs-per-query", type=int, default=3, help="Number of runs per query")
    parser.add_argument("--trigger-threshold", type=float, default=0.5, help="Trigger rate threshold")
    parser.add_argument("--model", default=None, help="Model to use for claude -p (default: user's configured model)")
    parser.add_argument("--verbose", action="store_true", help="Print progress to stderr")
    args = parser.parse_args()

    eval_set = json.loads(Path(args.eval_set).read_text())
    skill_path = Path(args.skill_path)

    if not (skill_path / "SKILL.md").exists():
        print(f"Error: No SKILL.md found at {skill_path}", file=sys.stderr)
        sys.exit(1)

    name, original_description, content = parse_skill_md(skill_path)
    description = args.description or original_description
    project_root = find_project_root()

    # Extract parent category name from skill_path (e.g., Commerce/JobEngine → ["Commerce"])
    # Only take the directory immediately before the skill name, filtering out path noise
    skills_dir = Path.home() / ".claude" / "skills"
    try:
        rel = skill_path.resolve().relative_to(skills_dir)
        # rel = Commerce/JobEngine → parent is "Commerce"
        parent_names = [rel.parts[0]] if len(rel.parts) > 1 else []
    except ValueError:
        # skill_path not under ~/.claude/skills, try raw parent
        parent_names = [skill_path.parts[-2]] if len(skill_path.parts) >= 2 else []

    if args.verbose:
        print(f"Evaluating: {description}", file=sys.stderr)
        if parent_names:
            print(f"Parent names for matching: {parent_names}", file=sys.stderr)

    output = run_eval(
        eval_set=eval_set,
        skill_name=name,
        description=description,
        num_workers=args.num_workers,
        timeout=args.timeout,
        project_root=project_root,
        runs_per_query=args.runs_per_query,
        trigger_threshold=args.trigger_threshold,
        model=args.model,
        parent_names=parent_names or None,
    )

    if args.verbose:
        summary = output["summary"]
        print(f"Results: {summary['passed']}/{summary['total']} passed", file=sys.stderr)
        for r in output["results"]:
            status = "PASS" if r["pass"] else "FAIL"
            rate_str = f"{r['triggers']}/{r['runs']}"
            print(f"  [{status}] rate={rate_str} expected={r['should_trigger']}: {r['query'][:70]}", file=sys.stderr)

    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
