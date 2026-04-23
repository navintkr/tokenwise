// Sample file so `@proctor` has real code to reason about during testing.
// Intentionally simple — the point is to exercise the pipeline, not this code.

export function helloWorld(name?: string): string {
  return `Hello, ${name ?? "world"}!`;
}

export async function fetchUser(id: string): Promise<{ id: string; name: string }> {
  // pretend this calls an API
  await new Promise((r) => setTimeout(r, 10));
  return { id, name: "Ada" };
}

if (require.main === module) {
  console.log(helloWorld());
  console.log(helloWorld("Conductor"));
}
