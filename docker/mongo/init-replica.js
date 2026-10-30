// Idempotent single-node replica set bootstrap. Run by the compose
// healthcheck: initiates rs0 on first boot, then reports health.
// The member host is the compose service name so other containers can
// reach it; host-machine clients connect with ?directConnection=true.
try {
  const status = rs.status();
  if (status.myState !== 1) quit(1); // not PRIMARY yet
} catch (e) {
  if (e.codeName !== 'NotYetInitialized') throw e;
  rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: 'mongodb:27017' }] });
  quit(1); // healthy on a later check, once elected PRIMARY
}
