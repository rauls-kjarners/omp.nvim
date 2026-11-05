local graphics = require("omp.graphics")
local ESC, ST = "\27", "\27\\"
local sent = {}
local relay = graphics._new_relay(function(data)
  sent[#sent + 1] = data
  return true
end)
local function receive(command)
  relay.receive(ESC .. "_G" .. command)
end

-- Real Kitty chunk boundaries: subsequent chunks have no image ID or action.
receive("a=t,f=100,q=2,i=42,m=1;YWJj")
receive("m=0;ZA==")
receive("a=p,U=1,q=2,i=42,c=12,r=3")
assert(relay.uploads == 1 and relay.placements == 1 and relay.bytes == 8)
assert(sent[2] == ESC .. "_Gm=0;ZA==" .. ST)
assert(sent[3]:find("U=1", 1, true))

-- Reject local/shared file transports, direct cursor placements, foreign image
-- deletions, unrelated terminal controls, and unbound continuation chunks.
local count = #sent
receive("a=t,f=100,t=f,i=43;L2V0Yy9wYXNzd2Q=")
receive("a=t,f=100,t=s,i=43;YWJj")
receive("a=p,i=42,c=12,r=3")
receive("a=d,d=I,i=999")
receive("m=0;YWJj")
relay.receive(ESC .. "]52;c;YWJj")
assert(#sent == count)

-- A global reset is translated to our own IDs, never forwarded verbatim.
receive("a=d,d=A,q=2")
assert(#sent == count + 1)
assert(sent[#sent] == ESC .. "_Ga=d,d=I,i=42,q=2" .. ST)
assert(next(relay.ids) == nil)

-- Missing transfer headers, non-base64 bytes and huge placements are ignored.
count = #sent
receive("a=t,f=24,i=50;YWJj")
receive("a=t,f=100,i=50;bad!payload")
receive("a=t,f=100,i=50,m=1;YWJj")
receive("m=0,t=f;ZA==")
receive("a=p,U=1,i=50,c=9999,r=3")
assert(#sent == count + 1)
relay.clear()
assert(next(relay.ids) == nil)

-- A failed write must never be counted as a completed image or placement.
local failed = graphics._new_relay(function()
  return false, "test write failure"
end)
failed.receive(ESC .. "_Ga=t,f=100,i=60;YWJj")
failed.receive(ESC .. "_Ga=p,U=1,i=60,c=2,r=2")
assert(failed.uploads == 0 and failed.placements == 0 and failed.bytes == 0)
assert(failed.error == "test write failure")
failed.clear()

-- Two attached terminals must not overwrite or delete each other's images.
local second_sent = {}
local second = graphics._new_relay(function(data)
  second_sent[#second_sent + 1] = data
  return true
end)
receive("a=t,f=100,i=70;YWJj")
second.receive(ESC .. "_Ga=t,f=100,i=70;ZA==")
second.receive(ESC .. "_Ga=d,d=I,i=70")
second.clear()
assert(#second_sent == 0 and relay.ids[70])
assert(second.rejected == 2 and second.error)
relay.clear()
second.receive(ESC .. "_Ga=t,f=100,i=70;ZA==")
assert(second.uploads == 1)
second.clear()

-- When not enabled, inherited shell settings cannot force invisible images.
graphics.setup()
assert(graphics.terminal_env().PI_FORCE_IMAGE_PROTOCOL == "none")
print("PASS: graphics chunks, protocol filtering, scoped deletion and cleanup")
