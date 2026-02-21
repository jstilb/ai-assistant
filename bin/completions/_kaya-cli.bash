#!/usr/bin/env bash
# kaya-cli Bash completion
# Install: source ~/.claude/bin/completions/_kaya-cli.bash
# Or add to ~/.bashrc: source ~/.claude/bin/completions/_kaya-cli.bash

_kaya_cli_completions() {
    local cur prev words cword
    _init_completion || return

    local services="youtube yt calendar gcal drive gmail gemini ai sheets places asana playwright pw browser bluesky bsky weather linear slack github gh gitlab op secrets stripe supabase firebase repl i interactive setup help version"

    local asana_commands="tasks create update complete delete move projects sections"
    local github_commands="pr issue repo workflow release"
    local gitlab_commands="mr issue project pipeline"
    local slack_commands="send channels"
    local linear_commands="issue project team"
    local op_commands="item read vault signin"
    local calendar_commands="agenda calw calm quick add delete edit"
    local drive_commands="lsd lsf copy sync move delete"
    local gmail_commands="inbox search send"
    local bluesky_commands="timeline post login profile feed"
    local stripe_commands="events customers charges subscriptions"
    local supabase_commands="projects db functions secrets"
    local firebase_commands="projects:list deploy hosting functions"
    local sheets_commands="list read write"
    local places_commands="nearby search details"

    # First argument: service
    if [[ $cword -eq 1 ]]; then
        COMPREPLY=($(compgen -W "$services" -- "$cur"))
        return
    fi

    # Second argument: subcommand based on service
    if [[ $cword -eq 2 ]]; then
        case "${words[1]}" in
            asana)
                COMPREPLY=($(compgen -W "$asana_commands" -- "$cur"))
                ;;
            github|gh)
                COMPREPLY=($(compgen -W "$github_commands" -- "$cur"))
                ;;
            gitlab)
                COMPREPLY=($(compgen -W "$gitlab_commands" -- "$cur"))
                ;;
            slack)
                COMPREPLY=($(compgen -W "$slack_commands" -- "$cur"))
                ;;
            linear)
                COMPREPLY=($(compgen -W "$linear_commands" -- "$cur"))
                ;;
            op|secrets)
                COMPREPLY=($(compgen -W "$op_commands" -- "$cur"))
                ;;
            calendar|gcal)
                COMPREPLY=($(compgen -W "$calendar_commands" -- "$cur"))
                ;;
            drive)
                COMPREPLY=($(compgen -W "$drive_commands" -- "$cur"))
                ;;
            gmail)
                COMPREPLY=($(compgen -W "$gmail_commands" -- "$cur"))
                ;;
            bluesky|bsky)
                COMPREPLY=($(compgen -W "$bluesky_commands" -- "$cur"))
                ;;
            stripe)
                COMPREPLY=($(compgen -W "$stripe_commands" -- "$cur"))
                ;;
            supabase)
                COMPREPLY=($(compgen -W "$supabase_commands" -- "$cur"))
                ;;
            firebase)
                COMPREPLY=($(compgen -W "$firebase_commands" -- "$cur"))
                ;;
            sheets)
                COMPREPLY=($(compgen -W "$sheets_commands" -- "$cur"))
                ;;
            places)
                COMPREPLY=($(compgen -W "$places_commands" -- "$cur"))
                ;;
        esac
        return
    fi

    # Options completion based on service and subcommand
    case "${words[1]}" in
        asana)
            case "${words[2]}" in
                tasks)
                    COMPREPLY=($(compgen -W "--project --completed --incomplete --json" -- "$cur"))
                    ;;
                create)
                    COMPREPLY=($(compgen -W "--project --notes --dry-run" -- "$cur"))
                    ;;
                update)
                    COMPREPLY=($(compgen -W "--name --notes --completed --json --dry-run" -- "$cur"))
                    ;;
                complete|delete)
                    COMPREPLY=($(compgen -W "--confirm --json --dry-run" -- "$cur"))
                    ;;
                move)
                    COMPREPLY=($(compgen -W "--section --json --dry-run" -- "$cur"))
                    ;;
                projects)
                    COMPREPLY=($(compgen -W "--archived --json" -- "$cur"))
                    ;;
                sections)
                    COMPREPLY=($(compgen -W "--json" -- "$cur"))
                    ;;
            esac
            ;;
        youtube|yt)
            COMPREPLY=($(compgen -W "--dump-json --extract-audio -x --output -o --format -f" -- "$cur"))
            ;;
        calendar|gcal)
            COMPREPLY=($(compgen -W "--tsv --nostarted" -- "$cur"))
            ;;
        gmail)
            COMPREPLY=($(compgen -W "--limit --format" -- "$cur"))
            ;;
        weather)
            COMPREPLY=($(compgen -W "--forecast --json" -- "$cur"))
            ;;
        bluesky|bsky)
            COMPREPLY=($(compgen -W "--json" -- "$cur"))
            ;;
        slack)
            case "${words[2]}" in
                send)
                    COMPREPLY=($(compgen -W "--channel --user" -- "$cur"))
                    ;;
            esac
            ;;
        stripe)
            COMPREPLY=($(compgen -W "--limit" -- "$cur"))
            ;;
    esac
}

complete -F _kaya_cli_completions kaya-cli
