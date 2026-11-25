import { config } from "../config.js";

/** Pinned repos (+ top starred) so Claude can pick the right proof project for each note. */
export async function listProjects(o: { readme_for?: string } = {}) {
  const token = config().GITHUB_TOKEN;
  const login = "Enochthedev";
  const headers: Record<string, string> = { "user-agent": "job-radar", accept: "application/vnd.github+json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
  if (o.readme_for) {
    const res = await fetch(`https://api.github.com/repos/${login}/${encodeURIComponent(o.readme_for)}/readme`, { headers: { ...headers, accept: "application/vnd.github.raw" } });
    if (!res.ok) throw new Error(`README ${o.readme_for}: ${res.status}`);
    return { repo: o.readme_for, readme: (await res.text()).slice(0, 12000) };
  }
  let pinned: unknown[] = [];
  if (token) {
    const q = `query { user(login: "${login}") { pinnedItems(first: 6, types: REPOSITORY) { nodes { ... on Repository { name description url stargazerCount primaryLanguage { name } repositoryTopics(first: 8) { nodes { topic { name } } } } } } } }`;
    const r = await fetch("https://api.github.com/graphql", { method: "POST", headers, body: JSON.stringify({ query: q }) });
    if (r.ok) {
      const j = (await r.json()) as { data?: { user?: { pinnedItems?: { nodes: { name: string; description: string; url: string; stargazerCount: number; primaryLanguage?: { name: string }; repositoryTopics: { nodes: { topic: { name: string } }[] } }[] } } } };
      pinned = (j.data?.user?.pinnedItems?.nodes ?? []).map((n) => ({ name: n.name, description: n.description, url: n.url, stars: n.stargazerCount, language: n.primaryLanguage?.name, topics: n.repositoryTopics.nodes.map((t) => t.topic.name) }));
    }
  }
  const r = await fetch(`https://api.github.com/users/${login}/repos?per_page=100&sort=pushed`, { headers });
  const repos = r.ok ? ((await r.json()) as { name: string; description: string | null; html_url: string; stargazers_count: number; language: string | null; topics?: string[]; fork: boolean; pushed_at: string }[]) : [];
  const top = repos.filter((x) => !x.fork).sort((a, b) => b.stargazers_count - a.stargazers_count).slice(0, 12)
    .map((x) => ({ name: x.name, description: x.description, url: x.html_url, stars: x.stargazers_count, language: x.language, topics: x.topics ?? [], pushed_at: x.pushed_at }));
  return { pinned, top_repos: top };
}
