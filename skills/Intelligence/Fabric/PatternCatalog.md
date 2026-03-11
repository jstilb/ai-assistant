# Fabric Pattern Catalog

Complete reference of 237 Fabric patterns organized by category.

**Location:** `~/.claude/skills/Intelligence/Fabric/Patterns/`

---

## Quick Reference

| Category | Count | Common Patterns |
|----------|-------|-----------------|
| Extraction | 35+ | `extract_wisdom`, `extract_insights`, `extract_main_idea` |
| Analysis | 35+ | `analyze_claims`, `analyze_code`, `analyze_malware` |
| Summarization | 20+ | `summarize`, `create_5_sentence_summary`, `youtube_summary` |
| Creation | 50+ | `create_threat_model`, `create_prd`, `create_mermaid_visualization` |
| Security | 15+ | `create_stride_threat_model`, `create_sigma_rules`, `analyze_incident` |
| Improvement | 10+ | `improve_writing`, `improve_prompt`, `review_code` |
| Rating | 8 | `rate_content`, `judge_output`, `rate_ai_response` |

---

## Extraction Patterns (35+)

Extract specific information from content.

| Pattern | Description |
|---------|-------------|
| `extract_wisdom` | IDEAS, INSIGHTS, QUOTES, HABITS, FACTS, REFERENCES |
| `extract_article_wisdom` | Article-specific wisdom extraction |
| `extract_book_ideas` | 50-100 ideas from books |
| `extract_book_recommendations` | Practical recommendations from books |
| `extract_insights` | Most powerful and insightful ideas |
| `extract_insights_dm` | Deep mode insights with summary |
| `extract_main_idea` | Core message in 15 words |
| `extract_recommendations` | Actionable recommendations |
| `extract_ideas` | All key ideas as bullet points |
| `extract_questions` | Questions from interviews |
| `extract_predictions` | Predictions with confidence levels |
| `extract_controversial_ideas` | Controversial statements |
| `extract_business_ideas` | Business opportunities |
| `extract_skills` | Skills from job descriptions |
| `extract_patterns` | Recurring patterns |
| `extract_references` | Art, books, literature references |
| `extract_instructions` | Step-by-step instructions |
| `extract_primary_problem` | Main problem presented |
| `extract_primary_solution` | Main solution presented |
| `extract_product_features` | Product features list |
| `extract_core_message` | Core message extraction |
| `extract_algorithm_update_recommendations` | Algorithm improvements |
| `extract_extraordinary_claims` | Scientifically disputed claims |
| `extract_most_redeeming_thing` | Most valuable aspect |
| `extract_jokes` | Humor extraction |
| `extract_sponsors` | Sponsor mentions |
| `extract_recipe` | Recipe with ingredients and steps |
| `extract_song_meaning` | Song meaning analysis |
| `extract_characters` | Character analysis from narratives |
| `extract_domains` | Domains and URLs from content |
| `extract_ctf_writeup` | CTF writeup extraction |
| `extract_poc` | Proof of concept URLs |
| `extract_videoid` | Video ID from URLs |
| `extract_latest_video` | Latest video from RSS |
| `extract_mcp_servers` | MCP server references |

---

## Analysis Patterns (35+)

Analyze and evaluate content.

| Pattern | Description |
|---------|-------------|
| `analyze_claims` | Fact-check claims with evidence |
| `analyze_code` | Code analysis |
| `analyze_malware` | Malware analysis for analysts |
| `analyze_paper` | Academic paper analysis |
| `analyze_paper_simple` | Simplified paper analysis |
| `analyze_logs` | Server log analysis |
| `analyze_debate` | Debate analysis with ratings |
| `analyze_incident` | Cybersecurity incident analysis |
| `analyze_comments` | Internet comment analysis |
| `analyze_answers` | Quiz answer evaluation |
| `analyze_email_headers` | SPF/DKIM/DMARC analysis |
| `analyze_military_strategy` | Historical battle analysis |
| `analyze_mistakes` | Past mistake analysis |
| `analyze_personality` | Psychological profile |
| `analyze_presentation` | Presentation critique |
| `analyze_product_feedback` | User feedback organization |
| `analyze_proposition` | Ballot proposition analysis |
| `analyze_prose` | Writing evaluation |
| `analyze_prose_json` | Writing evaluation (JSON) |
| `analyze_prose_pinker` | Pinker-style analysis |
| `analyze_risk` | Third-party vendor risk |
| `analyze_sales_call` | Sales call performance |
| `analyze_spiritual_text` | Spiritual text comparison |
| `analyze_tech_impact` | Technology impact assessment |
| `analyze_bill` | Legislation analysis |
| `analyze_bill_short` | Brief legislation analysis |
| `analyze_candidates` | Political candidate comparison |
| `analyze_cfp_submission` | Conference submission review |
| `analyze_terraform_plan` | Terraform plan analysis |
| `analyze_interviewer_techniques` | Interview technique analysis |
| `analyze_patent` | Patent analysis |

---

## Summarization Patterns (20+)

Condense content into summaries.

| Pattern | Description |
|---------|-------------|
| `summarize` | General summarization |
| `create_5_sentence_summary` | 5 levels: 5 sentences to 1 word |
| `create_micro_summary` | 20-word summary |
| `summarize_micro` | 3 points, 3 takeaways |
| `create_summary` | 20-word + 10 points + 5 takeaways |
| `summarize_meeting` | Meeting notes extraction |
| `summarize_paper` | Academic paper summary |
| `summarize_lecture` | Lecture with timestamps |
| `summarize_newsletter` | Newsletter content extraction |
| `summarize_debate` | Debate summary with analysis |
| `summarize_legislation` | Political proposal summary |
| `summarize_rpg_session` | RPG session summary |
| `summarize_board_meeting` | Board meeting notes |
| `summarize_git_changes` | Git changes (7 days) |
| `summarize_git_diff` | Git diff summary |
| `summarize_pull-requests` | PR summary |
| `summarize_prompt` | AI prompt summary |
| `youtube_summary` | YouTube video summary |
| `create_cyber_summary` | Cybersecurity summary |
| `create_ul_summary` | Unsupervised Learning summary |

---

## Creation Patterns (50+)

Generate new content.

| Pattern | Description |
|---------|-------------|
| `create_threat_model` | General threat modeling |
| `create_stride_threat_model` | STRIDE methodology |
| `create_threat_scenarios` | Threat scenario generation |
| `create_prd` | Product Requirements Document |
| `create_design_document` | C4 model design doc |
| `create_user_story` | Technical user stories |
| `create_coding_project` | Wireframes and starter code |
| `create_coding_feature` | Secure code features |
| `create_mermaid_visualization` | Mermaid diagrams |
| `create_markmap_visualization` | Markmap mindmaps |
| `create_visualization` | ASCII art visualizations |
| `create_excalidraw_visualization` | Excalidraw diagrams |
| `create_investigation_visualization` | Graphviz for investigations |
| `create_conceptmap` | Interactive concept maps |
| `create_report_finding` | Security finding reports |
| `create_newsletter_entry` | Newsletter-style summary |
| `create_keynote` | TED-style presentations |
| `create_academic_paper` | LaTeX academic papers |
| `create_flash_cards` | Study flashcards |
| `create_quiz` | Educational quizzes |
| `create_reading_plan` | Three-phase reading plan |
| `create_art_prompt` | AI art generation prompts |
| `create_command` | Pentest tool commands |
| `create_pattern` | New Fabric patterns |
| `create_logo` | Minimalist logo prompts |
| `create_tags` | Content tags |
| `create_video_chapters` | Video timestamps |
| `create_git_diff_commit` | Git commit messages |
| `create_graph_from_input` | Progress CSV data |
| `create_ttrc_graph` | TTRC metric CSV |
| `create_ttrc_narrative` | TTRC progress narrative |
| `create_diy` | DIY tutorials |
| `create_formal_email` | Professional emails |
| `create_hormozi_offer` | Business offers |
| `create_idea_compass` | Idea organization |
| `create_loe_document` | Level of effort estimates |
| `create_npc` | D&D NPC generation |
| `create_podcast_image` | Podcast imagery |
| `create_prediction_block` | Prediction formatting |
| `create_recursive_outline` | Hierarchical outlines |
| `create_rpg_summary` | RPG session documentation |
| `create_show_intro` | Podcast intros |
| `create_story_explanation` | Story-format explanations |
| `create_story_about_person` | Character stories |
| `create_story_about_people_interaction` | Persona interaction stories |
| `create_upgrade_pack` | World model updates |
| `create_aphorisms` | Witty statements |
| `create_better_frame` | Reality interpretation frames |
| `create_ai_jobs_analysis` | AI job impact analysis |
| `create_mnemonic_phrases` | Memory aid phrases |

---

## Security Patterns (15+)

Security analysis and rule generation.

| Pattern | Description |
|---------|-------------|
| `create_threat_model` | General threat modeling |
| `create_stride_threat_model` | STRIDE-based threat model |
| `create_threat_scenarios` | Attack scenario generation |
| `create_network_threat_landscape` | Network scan analysis |
| `create_security_update` | Security newsletter content |
| `create_sigma_rules` | SIGMA detection rules |
| `write_nuclei_template_rule` | Nuclei scanner templates |
| `write_semgrep_rule` | Semgrep static analysis rules |
| `analyze_threat_report` | Threat report insights |
| `analyze_threat_report_cmds` | Extract commands from reports |
| `analyze_threat_report_trends` | Identify threat trends |
| `analyze_incident` | Incident analysis |
| `analyze_risk` | Risk assessment |
| `analyze_malware` | Malware analysis |
| `ask_secure_by_design_questions` | Security design questions |
| `t_threat_model_plans` | Life plan threat modeling |

---

## Improvement Patterns (10+)

Enhance existing content.

| Pattern | Description |
|---------|-------------|
| `improve_writing` | General writing improvement |
| `improve_academic_writing` | Academic writing refinement |
| `improve_prompt` | LLM prompt optimization |
| `improve_report_finding` | Security finding improvement |
| `review_code` | Code review |
| `review_design` | Architecture review |
| `refine_design_document` | Design doc refinement |
| `humanize` | Make AI text natural |
| `enrich_blog_post` | Blog enhancement |
| `clean_text` | Fix broken formatting |
| `fix_typos` | Spelling/grammar correction |

---

## Rating & Evaluation Patterns (8)

Judge and rate content.

| Pattern | Description |
|---------|-------------|
| `rate_ai_response` | Grade AI outputs |
| `rate_ai_result` | Assess AI/ML work quality |
| `rate_content` | Content quality rating |
| `rate_value` | Value proposition rating |
| `judge_output` | General judgment |
| `label_and_rate` | Tag and tier assignment |
| `check_agreement` | Contract/agreement analysis |
| `arbiter-evaluate-quality` | Quality arbitration |

---

## Utility Patterns

General-purpose utilities.

| Pattern | Description |
|---------|-------------|
| `suggest_pattern` | Recommend appropriate patterns |
| `ai` | Deep question interpretation |
| `raw_query` | Direct LLM query |
| `convert_to_markdown` | Content to Markdown |
| `export_data_as_csv` | Data to CSV |
| `translate` | Language translation |
| `compare_and_contrast` | Item comparison table |
| `explain_code` | Code explanation |
| `explain_docs` | Documentation improvement |
| `explain_math` | Math concept explanation |
| `explain_project` | Project documentation summary |
| `explain_terms` | Glossary generation |
| `to_flashcards` | Anki flashcard creation |
| `tweet` | Tweet crafting guide |
| `write_essay` | Essay in author's style |
| `write_essay_pg` | Paul Graham style essay |
| `write_micro_essay` | Concise essay |
| `write_latex` | LaTeX generation |
| `write_hackerone_report` | Bug bounty reports |
| `write_pull-request` | PR descriptions |
| `get_youtube_rss` | YouTube RSS URL |
| `get_wow_per_minute` | Content wow-factor |
| `md_callout` | Markdown callout generation |

---

## TELOS Patterns (t_*)

Personal development and life planning patterns.

| Pattern | Description |
|---------|-------------|
| `t_analyze_challenge_handling` | Challenge response evaluation |
| `t_check_dunning_kruger` | Dunning-Kruger assessment |
| `t_check_metrics` | Progress metrics analysis |
| `t_create_h3_career` | Career wisdom |
| `t_create_opening_sentences` | Identity description |
| `t_describe_life_outlook` | Life outlook summary |
| `t_extract_intro_sentences` | Work/project summary |
| `t_extract_panel_topics` | Panel idea generation |
| `t_find_blindspots` | Blindspot identification |
| `t_find_negative_thinking` | Negative thinking analysis |
| `t_find_neglected_goals` | Goal tracking |
| `t_give_encouragement` | Progress encouragement |
| `t_red_team_thinking` | Thinking red team |
| `t_threat_model_plans` | Life plan threat model |
| `t_visualize_mission_goals_projects` | Mission visualization |
| `t_year_in_review` | Annual review |

---

## Specialized Patterns

Domain-specific patterns.

| Pattern | Description |
|---------|-------------|
| `agility_story` | User stories with acceptance criteria |
| `capture_thinkers_work` | Philosopher analysis |
| `coding_master` | Code concept explanation |
| `dialog_with_socrates` | Socratic dialogue |
| `find_female_life_partner` | Partner criteria analysis |
| `find_hidden_message` | Political message extraction |
| `find_logical_fallacies` | Fallacy identification |
| `heal_person` | Mental health guidance |
| `identify_dsrp_*` | Systems thinking patterns |
| `identify_job_stories` | Job requirements |
| `model_as_sherlock_freud` | Psychological modeling |
| `predict_person_actions` | Behavioral prediction |
| `prepare_7s_strategy` | 7S strategy briefing |
| `provide_guidance` | Life coaching |
| `recommend_artists` | Festival schedule |
| `recommend_pipeline_upgrades` | Pipeline optimization |
| `recommend_talkpanel_topics` | Conference topics |
| `recommend_yoga_practice` | Yoga guidance |
| `transcribe_minutes` | Meeting minutes |
| `ask_uncle_duke` | Multi-agent development |

---

## Usage

```bash
# Execute pattern natively (preferred)
# Kaya reads Patterns/{name}/system.md and applies directly

# Via fabric CLI
fabric "content" -p pattern_name
fabric -u "URL" -p pattern_name
fabric -y "YOUTUBE_URL" -p pattern_name
cat file.txt | fabric -p pattern_name
```

---

*Generated from pattern_explanations.md - 239 patterns*
