async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getStatus(port) {
  const res = await fetch(`http://localhost:${port}/status`);
  if (!res.ok) throw new Error(`status failed for ${port}`);
  return res.json();
}

async function run() {
  const before = await Promise.all([getStatus(9001), getStatus(9002), getStatus(9003)]);
  const leader = before.find((s) => s.role === "Leader");
  if (!leader) throw new Error("No leader found");

  console.log(`Leader is ${leader.nodeId}. Restart one follower container and wait for sync.`);
  console.log("This script validates post-restart convergence once manual restart is done.");

  await delay(4000);

  const after = await Promise.all([getStatus(9001), getStatus(9002), getStatus(9003)]);
  const maxCommit = Math.max(...after.map((s) => s.commitIndex));

  for (const st of after) {
    if (st.commitIndex !== maxCommit && st.role !== "Leader") {
      throw new Error(`Follower ${st.nodeId} not caught up. commitIndex=${st.commitIndex}, expected=${maxCommit}`);
    }
  }

  console.log("Restart sync validation passed (assuming follower restart was executed)");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
