<p align="center"><img src="public/img/logo.png" alt="CTENT — Conducting from Interior" width="260"></p>

# CTENT — research group workspace

CTENT is a web app where a research group can create a research topic, split it into parts, have the leader approve who owns each part, discuss the work, meet, submit drafts for review and keep files together.

This is **version 0.1, the first working build** for partner feedback. It has a real database, sign-in and role-based access.

![Dashboard](docs/screenshots/dashboard.png)

## Try it

The fastest way to see it is the hosted demo. Its link is shared separately once it's deployed; see [Deploy](#deploy-a-live-demo-on-render-free).

On the sign-in page, click any **demo account** to sign in as that person. Each one shows a different level of access:

| Account | Role | What they see |
|---|---|---|
| Nadia Karim | **Admin** | Everything, plus the admin console (users, roles, audit log) |
| Ehsan Hoque | **Leader** | Leads two topics; approves parts, reviews submissions, manages members |
| Dr. James Chen | **Leader** | Leads CT-0131 and is a member of other topics |
| Aisha Rahman, Priya Nair, Tom Walker, Sara Malik | **Member** | Only the topics they belong to |
| Rahul Mehta | **Member** | In no topics yet; has asked to join one |
| Dr. Lin Wei | **Guest** | External reviewer; read-only access to the overview, submissions and files |

Every demo account uses the password `demo1234`. Everyone trying the demo shares the same data.

## How research works now: AI agents

Every project follows five steps, shown as a bar at the top of each project page: **Question → Research → Review → Write → Finish**. The project's home page (**Journey**) always shows the one next step with a button for it. Each project has five tabs: **Journey**, **Research** (parts and agents), **Paper**, **Team** (chat, meetings, people, activity) and **Files** (files and submissions), plus **Settings** for leaders. New projects are created in a three-step wizard: question, how to split it (AI suggestion or a template), and co-authors.

1. **Ask the question.** Create a topic and write the research question.
2. **Split it into parts.** Each part gets its own agent with a brief, the sources it may use and how deep to go. Templates and **Suggest parts** do this for you.
3. **Agents research.** Each part's agent (merged from the standalone CTENT Research Agent):
   - splits its part into sub-questions and searches every selected source for each one;
   - merges the same paper found in several databases, ranks the results, follows the **citation trail** of the best papers and checks Crossref for **retractions** and questionable journals;
   - reads abstracts and free **open-access full texts**, and turns each source into an **evidence card**: key findings, data points, method, sample, limitations, a quote checked against the text, a reliability rating and a ready Harvard citation;
   - maps where sources **agree and contradict**, and finds **research gaps** with suggested research questions.
   Findings can be written in English or **Bangla** (বাংলা). Two agents run at a time; Quick takes about 3 minutes, Standard 8, Deep up to 25.
4. **Review the evidence.** The part's page has five tabs: **Evidence** (cards with search, filters and sorting), **Agreement**, **Gaps**, **Overview** (charts) and **Log**. Tick the cards you want, then **accept** them or click **Write paper section from selected**. Export an evidence pack (.docx/.md), a literature matrix (.xlsx) or a research gaps brief (.docx). Ask the agent to dig deeper, or run it again. Co-authors can comment.
5. **Write the final paper.** There's a section per part plus an introduction and conclusion.
   - Insert accepted findings, which keep their citations, or click **Draft from findings**.
   - The reference list (Harvard) builds itself.
   - Export to Word or PDF, or save the paper as the project's **final report**.

### Connect a free AI service

Agents work without any key, but in that case they only list the key lines from each source. For written summaries and findings, add free keys on Render under **ctent → Environment**. Add more than one AI key: when one is busy or over its free limit, agents switch to the next one automatically.

| Service | Key name | Get it |
|---|---|---|
| Google Gemini (AI, first choice) | `GEMINI_API_KEY` | https://aistudio.google.com/apikey |
| Groq (AI backup) | `GROQ_API_KEY` | https://console.groq.com/keys |
| OpenRouter (AI backup, free models) | `OPENROUTER_API_KEY` | https://openrouter.ai/keys |
| OpenAlex (papers, bigger daily budget) | `OPENALEX_API_KEY` | https://openalex.org/settings/api |
| Semantic Scholar (papers, private rate limit) | `S2_API_KEY` | https://www.semanticscholar.org/product/api |
| CORE (open-access full texts) | `CORE_API_KEY` | https://core.ac.uk/services/api |
| Your email (polite use of the free services) | `CONTACT_EMAIL` | — |

Sources, all free and chosen per part:

| Group | Sources |
|---|---|
| Academic papers | OpenAlex, Semantic Scholar, CrossRef, DOAJ, arXiv, PubMed, Europe PMC, CORE (key) |
| Books | Open Library, Google Books |
| Data & reports | World Bank documents and reports |
| Reference | Wikipedia (+ Bangla Wikipedia) |
| Islamic sources | Qur'an (Sahih International + Bangla translation), Hadith (Sunnah.com, HadithBD) |
| Web & news | DuckDuckGo web and news |
| Bangladesh | BanglaJOL, Bangladesh Bureau of Statistics, Bangladesh Bank, The Daily Star, Prothom Alo (ticked automatically for Bangla research) |

Web, news, Hadith and Bangladesh sources use DuckDuckGo, which sometimes blocks searches from cloud servers. When that happens the agent notes it in the log and carries on with the other sources. Full-text reading needs `CONTACT_EMAIL` for Unpaywall.

Runs are stopped automatically if they take far too long (Quick 10 minutes, Standard 20, Deep 35; `AGENT_MAX_MINUTES` raises the limit). Researchers can also press **Stop** and run it again.

The standalone Python version of the research agent is kept in `research-agent/` for testing on your own computer (`python app.py`); the website uses the JavaScript version built into CTENT.

### Showcase website (plain HTML and CSS)

Finished papers can be published on a separate public website, for example on free GitHub Pages.

1. On a completed project's **Finish** page (or the paper's **Showcase page** menu), press **Add to showcase website**.
2. On **Topics → Completed**, press **Download showcase website**. You get a zip with `index.html`, `about.html` and one page per paper in `papers/`.
3. Create a public GitHub repository, for example `ctent-showcase`. Unzip and upload the files with **Add file → Upload files**.
4. In the repository, open **Settings → Pages**, choose **Deploy from a branch**, branch `main`, folder `/ (root)`, and save. The site appears at `https://<your-username>.github.io/ctent-showcase/`.
5. When a new paper is finished, download the zip again and upload the files over the old ones.

Set the site's name with `SHOWCASE_NAME`, and optionally `SHOWCASE_TAGLINE` and `SHOWCASE_CONTACT`.

## What works in this version

- **Sign-in and roles:** Admin > Leader > Member > Guest.
  - Members can't create topics and only see their own topics.
  - Guests only see what they've been given.
  - Admins see everything.
- **Topics:**
  - Create a topic from a template: journal paper, field study, policy analysis or grant application.
  - Topics can be private, institution-wide or open.
  - People can ask to join a topic, and the leader accepts or declines.
  - A topic can be archived (becomes read-only) or deleted.
- **Plan & assign:**
  - Split a topic into parts.
  - CTENT ranks members by matching their expertise to the part and checking their current workload.
  - **The leader approves the owner. Nothing is assigned automatically.**
  - Approving a part creates the task and notifies the owner.
- **Task workspace (new):**
  - Leaders create a task with a **brief**: goal, what to hand in, "done when" points and starter files.
  - A brief-quality score and a live preview show what the member will see.
  - The member's task page always shows **one next step**, with a progress stepper (Assigned → Working → In review → Approved).
  - Members keep their own step checklist, upload drafts as versions, post updates (including an "I'm blocked" alert), and use a chat for that task only.
  - Leaders review by ticking each "done when" point. Approve only works when every point is met; anything unmet goes back as a change request automatically.
- **Board:**
  - Kanban with To do, In progress, In review and Done.
  - Drag and drop, or use the status menu on each card.
  - Filter by person.
  - Members can only move their own cards.
- **Messages:**
  - Every topic has channels, and anyone can create a private room across topics.
  - Messages arrive live without reloading.
  - @mentions notify the person mentioned.
- **Language switch (English / বাংলা):**
  - Use the 🌐 button in the top bar, or on the sign-in page. The choice is remembered on that browser.
  - The whole interface is translated: menus, buttons, forms, messages, confirmations, dates and times. What people type (titles, messages, file names) stays exactly as written.
  - Translations are in `src/locales/bn.js`. Edit a line to improve a phrase. To add a language, copy that file and add the language to `src/lib/i18n.js`.
- **Finish a project:**
  - Leaders and admins get a **🎉 Finish project** button, which opens a congratulations page showing the team's results.
  - The leader chooses the **final report**: an approved submission, approved task work, any file in the project, or a new upload. It's saved with the topic.
  - Everyone in the topic is notified. The report stays one click away from the topic, from **Topics → 🏆 Completed**, and from **🏆 Final report** in the topic header. It can't be deleted by accident.
  - A leader can change the report or reopen the project at any time.
- **Expertise when assigning:** the people picker for a new task and the Plan & assign suggestions show each person's top skills with their level (1–5). Skills that match the part are highlighted.
- **Meeting rooms:**
  - Every topic gets a **project room** automatically: an always-open video room (free Jitsi link, or paste your own Zoom/Meet/Teams room) for everyone in the topic, linked to its chat.
  - Anyone can add **team rooms**. Pick a part or task and its people are filled in for you, then add or remove anyone. Each team room can have its own group chat.
  - Meetings can be scheduled in a room. A team-room meeting uses that room's link and only notifies its people.
- **Meetings:**
  - Paste a Zoom, Google Meet or Teams link and the platform is detected automatically.
  - Members are notified when a meeting is scheduled.
  - Past meetings have a place to record minutes.
- **Submissions & review:**
  - Upload a file and add new versions.
  - Text and CSV files show a line-by-line comparison between versions.
  - Leaders can approve, request changes or comment.
  - Approved versions are locked, and authors can't review their own work.
- **Files:** folders per topic, upload and download, and preview for PDFs, images and text.
- **Action centre:** one place for everything waiting on your decision: part approvals, reviews, join requests and overdue tasks.
- **Notifications, search, profile & expertise** (fields rated 1–5, used for matching), **light and dark theme**, and **mobile layout**.
- **Admin console:**
  - Create users (each gets a one-time temporary password), change roles, suspend or restore accounts, and reset passwords.
  - Platform stats.
  - Audit log.
- **Activity log** for each topic.
- **Edit and delete everywhere, by role:**
  - **Members** edit or delete their own messages, task comments, updates, steps, unsent drafts, meetings they organised, files they uploaded, submissions (until approved), expertise and notifications.
  - **Leaders** can also edit or delete anything in topics they lead: the topic, parts, task briefs, meetings, channels, files and submissions, and remove anyone's message.
  - **Admins** can do all of that in every topic, and edit or delete user accounts. A topic's only leader can't be deleted, and nobody can delete their own account.
  - Edited messages show "(edited)", deleted chat messages leave a placeholder, and chat edits appear live for everyone.

| Plan & assign | Submission review |
|---|---|
| ![Plan & assign](docs/screenshots/plan-assign.png) | ![Review](docs/screenshots/submission-review.png) |
| **Board** | **Messages** |
| ![Board](docs/screenshots/board.png) | ![Messages](docs/screenshots/messages.png) |

## Deploy a live demo on Render (free)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/ehsanulhoquipsc/ctent)

1. Push this repository to GitHub. This step is already done if you're reading this on GitHub.
2. Sign in at [render.com](https://render.com) with your GitHub account.
3. Click **New + → Blueprint**, pick this repository, and click **Apply**.
   - Render reads `render.yaml` and creates a free web service and a free PostgreSQL database.
   - It also generates the session secret.
4. Wait about 3–5 minutes for the first build. Your link will look like `https://ctent-xxxx.onrender.com`.
5. Open the link. The first start loads the demo data automatically.

Free-plan limits to know before sharing the link:

- The free service sleeps after 15 minutes without visitors, and the next visit takes about a minute to wake it up.
- Render's free database expires 30 days after it's created. Upgrade it, or create a new one, to keep the demo running.
- Uploaded files are stored in the database. That's fine for a demo, but large files should move to object storage for real use.

## Run it on your computer

You need [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
npm run dev          # http://localhost:3000, uses a local SQLite file in data/
npm test             # 34 automated tests (sign-in, permissions, workflows)
npm run reset-demo   # wipe the database and reload the demo data
```

To run against PostgreSQL locally, set `DATABASE_URL=postgres://…`. All settings are listed in `.env.example`.

### Before real (non-demo) use

- Set `DEMO_LOGINS=false` so the one-click demo buttons disappear from the sign-in page.
- Set `SEED_DEMO=false` and start with an empty database. The first visit then opens **Create admin account**.
- Keep `SESSION_SECRET` long and private.

## How it's built

- **Server:** Node.js and Express 5, with server-rendered EJS pages and a little plain JavaScript for drag-and-drop, live chat and the theme.
- **Database:** PostgreSQL on Render, or SQLite locally, through the same Knex queries. Migrations are in `src/migrations`.
- **Security:**
  - Passwords are hashed with bcrypt, and sessions are stored in the database.
  - Every form is protected against cross-site request forgery (CSRF).
  - Sign-in attempts are rate-limited.
  - Strict security headers (CSP via Helmet).
  - Every page and action checks the user's role on the server, and output is escaped.
  - Uploads have a size limit and executable files are blocked.

```
src/
  app.js, server.js, db.js, seed.js
  lib/        auth & permissions, notifications, action centre, helpers
  routes/     auth, dashboard, topics, work (plan/board/meetings), messages, review (submissions/files), people, admin
  views/      page templates
public/       CSS (design tokens, light/dark), JS, logo
test/         automated tests
```

## Coming next (round 2)

- Email invitations and password-reset emails
- Final report builder, guest reviewer scoring portal, ethics checklist, budget and grants, and datasets with access requests
- Timeline (Gantt) view and growth analytics
- Two-factor sign-in
- File storage in S3 or R2, and real-time chat over WebSockets

## Feedback

Open an issue on this repository, or send notes to the CTENT team.
