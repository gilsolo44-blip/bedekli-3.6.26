# בדקלי — הוראות התקנה

## שלב 1 — הקמת Supabase (חינמי)

1. כנס ל-https://supabase.com → **Start for free**
2. צור פרויקט חדש (בחר אזור קרוב, למשל `eu-central-1`)
3. לאחר יצירת הפרויקט, כנס ל-**Settings → API** ושמור:
   - `Project URL` → זה `SUPABASE_URL`
   - `anon public` key → זה `SUPABASE_ANON_KEY`
   - `service_role` key → זה `SUPABASE_SERVICE_KEY` (סודי! לשרת בלבד)

### צור את הטבלאות — כנס ל-SQL Editor והרץ:

```sql
-- דוחות
create table reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users not null,
  file_name text,
  property_type text default 'new',
  created_at timestamptz default now(),
  data jsonb not null
);
alter table reports enable row level security;
create policy "users see own reports"
  on reports for all using (auth.uid() = user_id);

-- מעקב סטטוס ממצאים
create table report_status (
  report_id uuid references reports on delete cascade,
  defect_id int,
  status text default 'pending',
  note text default '',
  primary key (report_id, defect_id)
);
alter table report_status enable row level security;
create policy "users manage own status"
  on report_status for all
  using (auth.uid() = (select user_id from reports where id = report_id));

-- rate limiting
create table usage (
  user_id uuid references auth.users,
  date date,
  count int default 0,
  primary key (user_id, date)
);
alter table usage enable row level security;
```

4. כנס ל-**Authentication → Email** וודא שאימות אימייל מופעל

---

## שלב 2 — עדכון הקוד עם הפרטים שלך

### public/index.html ו-public/report.html
חפש `REPLACE_WITH_YOUR_SUPABASE_URL` והחלף בכתובת הפרויקט.
חפש `REPLACE_WITH_YOUR_SUPABASE_ANON_KEY` והחלף במפתח ה-anon.

---

## שלב 3 — Deploy ל-Vercel (חינמי)

1. צור חשבון ב-https://vercel.com (חינמי)
2. התקן Vercel CLI:
   ```
   npm i -g vercel
   ```
3. מתוך תיקיית הפרויקט, הרץ:
   ```
   vercel
   ```
4. עקוב אחר ההוראות (בחר scope, שם פרויקט)

### הגדר Environment Variables ב-Vercel:
כנס ל-Vercel Dashboard → הפרויקט → **Settings → Environment Variables** והוסף:

| שם | ערך |
|---|---|
| `ANTHROPIC_API_KEY` | המפתח שלך מ-console.anthropic.com |
| `SUPABASE_URL` | כתובת הפרויקט |
| `SUPABASE_SERVICE_KEY` | מפתח ה-service_role (סודי) |

5. לאחר הוספת המשתנים, הרץ שוב:
   ```
   vercel --prod
   ```

---

## מבנה הקבצים

```
bedekli/
├── public/
│   ├── index.html     ← דף הבית + העלאה
│   └── report.html    ← דוח אינטראקטיבי
├── api/
│   └── analyze.js     ← פרוקסי ל-Anthropic (סודי)
├── package.json
├── vercel.json
└── SETUP.md           ← המסמך הזה
```

---

## מגבלות ה-Free Tier

| שירות | מגבלה |
|---|---|
| Vercel | 100GB bandwidth/חודש |
| Supabase Auth | 50,000 משתמשים |
| Supabase DB | 500MB |
| Rate limit (אפליקציה) | 5 ניתוחים/משתמש/יום |
| Anthropic | לפי שימוש בלבד (אין מגבלה, יש עלות) |
