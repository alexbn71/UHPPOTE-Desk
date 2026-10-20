-- Wireshark dissector for the UHPPOTE UT0311-L0x controller protocol (UDP 60000, events on 60001).
--
-- Install: copy this file to %APPDATA%\Wireshark\plugins\ (Linux/macOS: ~/.local/lib/wireshark/plugins/),
-- then Analyze → Reload Lua Plugins (Ctrl+Shift+L). Display filter: uhppote
--
-- 64-byte packets (start 0x17, or 0x19 for v6.62 events) are decoded field by field; for 0xF2 (write parameters,
-- reconstructed from the vendor software) every byte is named, including the UT0311-01A expansion board table.
-- Packets of other sizes are the vendor's older long-packet protocol: only their header is shown.

local p = Proto('uhppote', 'UHPPOTE access controller')

local FUNCTIONS = {
  [0x20] = 'status', [0x30] = 'set-time', [0x32] = 'get-time', [0x40] = 'open-door',
  [0x50] = 'put-card', [0x52] = 'delete-card', [0x54] = 'delete-all-cards', [0x58] = 'get-cards',
  [0x5a] = 'get-card', [0x5c] = 'get-card-at-index', [0x80] = 'set-door-control', [0x82] = 'get-door-control',
  [0x84] = 'set-antipassback', [0x86] = 'get-antipassback', [0x88] = 'set-time-profile',
  [0x8a] = 'clear-time-profiles', [0x8c] = 'set-door-passcodes', [0x8e] = 'record-special-events',
  [0x90] = 'set-listener', [0x92] = 'get-listener', [0x94] = 'get-controller', [0x96] = 'set-ipv4',
  [0x98] = 'get-time-profile', [0xa0] = 'set-pc-control', [0xa2] = 'set-interlock', [0xa4] = 'activate-keypads',
  [0xa6] = 'clear-task-list', [0xa8] = 'add-task', [0xaa] = 'set-first-card', [0xac] = 'refresh-task-list',
  [0xae] = 'set-warnings (?)', [0xb0] = 'get-event', [0xb2] = 'set-event-index', [0xb4] = 'get-event-index',
  [0xb6] = 'read-data-flash', [0xb8] = 'write-data-flash', [0xba] = 'erase-data-flash',
  [0xc0] = 'reset-alarm-output (?)', [0xc2] = 'get-alarm-status (?)', [0xc8] = 'restore-default-parameters',
  [0xf2] = 'write-parameters',
}

local REASONS = {
  [1] = 'swipe', [2] = 'swipe open', [3] = 'swipe close', [5] = 'denied (system)', [6] = 'no access rights',
  [7] = 'incorrect password', [8] = 'anti-passback', [9] = 'more cards', [10] = 'first card open',
  [11] = 'door normally closed', [12] = 'interlock', [13] = 'not in allowed time period', [15] = 'invalid time zone',
  [18] = 'access denied', [20] = 'push button ok', [23] = 'door opened', [24] = 'door closed',
  [25] = 'supervisor door open', [28] = 'controller power on', [29] = 'controller reset',
  [31] = 'push button: door locked', [32] = 'push button: offline', [33] = 'push button: interlock',
  [34] = 'push button: threat', [37] = 'door open too long', [38] = 'forced open', [39] = 'fire',
  [40] = 'forced closed', [41] = 'theft prevention', [42] = 'zone 24x7', [43] = 'emergency', [44] = 'remote open door',
  [45] = 'remote open door (USB)',
}

local EVENT_TYPES = { [0] = 'none', [1] = 'swipe', [2] = 'door', [3] = 'alarm', [255] = 'overwritten' }

local f = {
  som = ProtoField.uint8('uhppote.som', 'Start of message', base.HEX),
  func = ProtoField.uint8('uhppote.function', 'Function', base.HEX, FUNCTIONS),
  serial = ProtoField.uint32('uhppote.serial', 'Controller serial', base.DEC),
  ok = ProtoField.uint8('uhppote.ok', 'Result (1 = ok)', base.DEC),
  magic = ProtoField.uint32('uhppote.magic', 'Magic', base.HEX),
  -- 0xF2
  pw = ProtoField.bytes('uhppote.param', 'Parameter write'),
  paddr = ProtoField.uint16('uhppote.param.address', 'Address', base.DEC),
  pindex = ProtoField.uint16('uhppote.param.index', 'Index', base.DEC),
  pvalue = ProtoField.uint8('uhppote.param.value', 'Value', base.HEX),
  pname = ProtoField.string('uhppote.param.name', 'Meaning'),
  -- status / event
  eindex = ProtoField.uint32('uhppote.event.index', 'Event index', base.DEC),
  etype = ProtoField.uint8('uhppote.event.type', 'Event type', base.DEC, EVENT_TYPES),
  granted = ProtoField.uint8('uhppote.event.granted', 'Granted', base.DEC),
  door = ProtoField.uint8('uhppote.event.door', 'Door', base.DEC),
  dir = ProtoField.uint8('uhppote.event.direction', 'Direction', base.DEC, { [1] = 'in', [2] = 'out' }),
  card = ProtoField.uint32('uhppote.event.card', 'Card', base.DEC),
  ts = ProtoField.string('uhppote.event.timestamp', 'Timestamp'),
  reason = ProtoField.uint8('uhppote.event.reason', 'Reason', base.DEC, REASONS),
  doors = ProtoField.string('uhppote.status.doors', 'Doors open (1-4)'),
  buttons = ProtoField.string('uhppote.status.buttons', 'Buttons pressed (1-4)'),
  syserr = ProtoField.uint8('uhppote.status.error', 'System error', base.HEX),
  special = ProtoField.uint8('uhppote.status.special', 'Special info', base.HEX),
  relays = ProtoField.uint8('uhppote.status.relays', 'Relays (bit0-3 = doors 1-4, bit4-7 = ?)', base.HEX),
  inputs = ProtoField.uint8('uhppote.status.inputs', 'Inputs (bit0 force lock, bit1 fire, others = ?)', base.HEX),
  fire = ProtoField.bool('uhppote.status.fire', 'Fire alarm'),
  -- long packets
  long = ProtoField.bytes('uhppote.long', 'Vendor long-packet protocol'),
  ltype = ProtoField.uint8('uhppote.long.type', 'Type', base.HEX),
  lcode = ProtoField.uint8('uhppote.long.code', 'Code', base.HEX, {
    [0x10] = 'read parameters / run info', [0x11] = 'read reply', [0x20] = 'write parameter table', [0x21] = 'write reply',
  }),
  lxid = ProtoField.uint32('uhppote.long.xid', 'Transaction id', base.DEC),
  lfrom = ProtoField.uint32('uhppote.long.from', 'From serial', base.DEC),
  lto = ProtoField.uint32('uhppote.long.to', 'To serial (0xffffffff = any)', base.DEC),
  ltable = ProtoField.bytes('uhppote.long.table', 'Parameter table'),
  lflagged = ProtoField.uint16('uhppote.long.flagged', 'Bytes marked for update', base.DEC),
}
p.fields = f
p.prefs.listener_port = Pref.uint('Listener (event) port', 60001, 'UDP port where the controllers send their events')

-- --- parameter table -------------------------------------------------------------------------------------------

local SOURCES = { [0] = 'door 1', [1] = 'door 2', [2] = 'door 3', [3] = 'door 4', [16] = 'ARM (burglar alarm)' }
local MODES = {
  [0] = 'inactive', [1] = 'for the duration', [2] = 'for the duration and until reset', [3] = 'until reset',
  [4] = 'any signal', [5] = 'all signals',
}
local EVENT_BITS = { 'duress', 'open too long', 'forced open', 'forced lock', 'invalid card', 'fire', 'ARM', 'duress only after a card' }
local SIGNAL_BITS = { 'lock relay', 'door sensor', 'push button', 'force lock', 'ExtA1', 'ExtA2', 'ExtA3', 'Ext fire' }

local function bits(v, names)
  local out = {}
  for i, name in ipairs(names) do
    if v & (1 << (i - 1)) ~= 0 then out[#out + 1] = name end
  end
  if #out == 0 then return 'none' end
  return table.concat(out, ', ')
end

local function param_name(index, value)
  if index >= 136 and index < 160 then
    local n = (index - 136) // 6 + 1
    local field = (index - 136) % 6
    local prefix = string.format('expansion output %d: ', n)
    if field == 0 then return prefix .. 'source = ' .. (SOURCES[value] or '?') end
    if field == 1 then return prefix .. 'mode = ' .. (MODES[value] or '?') end
    if field == 2 then return prefix .. 'events = ' .. bits(value, EVENT_BITS) end
    if field == 3 then return prefix .. 'signals = ' .. bits(value, SIGNAL_BITS) end
    if field == 4 then return prefix .. 'duration low byte (tenths of a second)' end
    return prefix .. 'duration high byte'
  end
  if index >= 2 and index <= 9 then return string.format('door %d open delay %s byte (tenths of a second)', (index - 2) // 2 + 1, index % 2 == 0 and 'low' or 'high') end
  if index >= 10 and index <= 13 then return string.format('door %d control (1 open, 2 closed, 3 controlled)', index - 9) end
  if index >= 14 and index <= 17 then return string.format('door %d interlock', index - 13) end
  if index >= 168 and index <= 171 then return string.format('door %d multi-card: cards needed', index - 167) end
  if index >= 172 and index <= 203 then return string.format('door %d multi-card group %d', (index - 172) // 8 + 1, (index - 172) % 8 + 1) end
  if index >= 218 and index <= 221 then return string.format('door %d multi-card options', index - 217) end
  if index >= 22 and index <= 25 then return string.format('reader %d keypad', index - 21) end
  local names = {
    [26] = 'push button default state', [27] = 'door sensor default state', [28] = 'lock normal state',
    [29] = 'record push button events', [30] = 'record alarm events', [31] = 'anti-passback',
    [32] = 'alarm types = ' .. bits(value, EVENT_BITS), [35] = 'door open too long, low byte (tenths of a second)',
    [41] = 'alarm auto reset', [42] = 'minimum alarm output time', [45] = 'ARM control mode', [46] = 'ARM delay (s)',
    [47] = 'disarm delay (s)', [56] = 'receive fire signal (network)', [57] = 'send fire signal (network)',
    [60] = 'ARM status', [74] = 'duress code, low byte', [75] = 'duress code, middle byte',
    [162] = 'door open too long, high byte', [163] = 'duress code, high byte',
    [40] = 'multi-card doors (bit per door, factory 0x55)', [52] = 'swipe gap, low byte (units of 2 s)',
    [53] = 'swipe gap, high byte', [205] = 'silent reader on invalid card (0xA5 = on)',
    [222] = 'door as switch (inverted door bits)', [250] = 'four swipes = normally open (bits 0-3 readers, 4-7 time profile)',
    [245] = 'invalid card alarm after N swipes (0 = every swipe)',
    [252] = 'open too long alarm (0xA5 = on)',
  }
  if index >= 384 and index <= 387 then return 'network: IP address' end
  if index >= 388 and index <= 391 then return 'network: netmask' end
  if index >= 392 and index <= 395 then return 'network: gateway' end
  if index >= 116 and index <= 129 then return 'network configuration (factory copy?)' end
  return names[index] or '?'
end

-- --- decoders --------------------------------------------------------------------------------------------------

local function bcd(tvb, off, len)
  local s = ''
  for i = 0, len - 1 do s = s .. string.format('%02x', tvb(off + i, 1):uint()) end
  return s
end

local function flags4(tvb, off)
  local s = ''
  for i = 0, 3 do s = s .. (tvb(off + i, 1):uint() ~= 0 and '1' or '0') end
  return s
end

local function status(tvb, tree)
  tree:add_le(f.eindex, tvb(8, 4))
  tree:add(f.etype, tvb(12, 1))
  tree:add(f.granted, tvb(13, 1))
  tree:add(f.door, tvb(14, 1))
  tree:add(f.dir, tvb(15, 1))
  tree:add_le(f.card, tvb(16, 4))
  local t = bcd(tvb, 20, 7)
  tree:add(f.ts, tvb(20, 7), string.format('%s-%s-%s %s:%s:%s', t:sub(1, 4), t:sub(5, 6), t:sub(7, 8), t:sub(9, 10), t:sub(11, 12), t:sub(13, 14)))
  tree:add(f.reason, tvb(27, 1))
  tree:add(f.doors, tvb(28, 4), flags4(tvb, 28))
  tree:add(f.buttons, tvb(32, 4), flags4(tvb, 32))
  tree:add(f.syserr, tvb(36, 1))
  tree:add(f.special, tvb(48, 1))
  tree:add(f.relays, tvb(49, 1))
  tree:add(f.inputs, tvb(50, 1))
  tree:add(f.fire, tvb(50, 1), tvb(50, 1):uint() & 0x02 ~= 0)
  local reason = tvb(27, 1):uint()
  return string.format('event %d, door %d, card %d, %s', tvb(8, 4):le_uint(), tvb(14, 1):uint(), tvb(16, 4):le_uint(), REASONS[reason] or ('reason ' .. reason))
end

local function write_parameters(tvb, tree)
  tree:add_le(f.magic, tvb(8, 4))
  local count = 0
  for k = 0, 7 do
    local off = 12 + 3 * k
    local address = tvb(off, 2):le_uint()
    if address ~= 0 then
      local value = tvb(off + 2, 1):uint()
      local index = address - 16
      local name = param_name(index, value)
      local item = tree:add(f.pw, tvb(off, 3)):set_text(string.format('[%d] = 0x%02x (%d)  %s', index, value, value, name))
      item:add_le(f.paddr, tvb(off, 2))
      item:add(f.pindex, tvb(off, 2), index)
      item:add(f.pvalue, tvb(off + 2, 1))
      item:add(f.pname, tvb(off, 3), name)
      count = count + 1
    end
  end
  return string.format('%d parameter(s)', count)
end

function p.dissector(tvb, pinfo, tree)
  local len = tvb:len()
  if len == 0 then return 0 end
  pinfo.cols.protocol = 'UHPPOTE'
  local root = tree:add(p, tvb(), 'UHPPOTE access controller')

  if len ~= 64 then
    local item = root:add(f.long, tvb())
    item:set_text(string.format('Vendor long-packet protocol (%d bytes)', len))
    local info = string.format('long packet, %d bytes, type 0x%02x code 0x%02x', len, tvb(0, 1):uint(), len >= 2 and tvb(1, 1):uint() or 0)
    if len >= 20 then
      local ptype, code = tvb(0, 1):uint(), tvb(1, 1):uint()
      item:add(f.ltype, tvb(0, 1))
      item:add(f.lcode, tvb(1, 1))
      item:add_le(f.lxid, tvb(4, 4))
      item:add_le(f.lfrom, tvb(8, 4))
      item:add_le(f.lto, tvb(12, 4))
      if ptype == 0x24 and (code == 0x11 or code == 0x20) and len >= 1044 then
        local tvt = tvb(20, 1024):tvb()
        local tbl = item:add(f.ltable, tvb(20, 1024))
        tbl:set_text('Parameter table (1024 bytes)')
        local flagged = nil
        if code == 0x20 and len >= 1172 then
          flagged = 0
          for i = 0, 1023 do
            if tvb(1044 + (i >> 3), 1):uint() & (1 << (i & 7)) ~= 0 then flagged = flagged + 1 end
          end
          item:add(f.lflagged, tvb(1044, 128), flagged)
        end
        local interesting = { 2, 4, 6, 8, 10, 11, 12, 13, 30, 32, 35, 40, 52, 74, 75, 162, 163, 168, 169, 170, 171, 205, 222, 245, 250, 252 }
        for i = 136, 159 do interesting[#interesting + 1] = i end
        for _, i in ipairs(interesting) do
          local v = tvt(i, 1):uint()
          tbl:add(f.pw, tvt(i, 1)):set_text(string.format('[%d] = 0x%02x (%d)  %s', i, v, v, param_name(i, v)))
        end
        local function ip(o) return string.format('%d.%d.%d.%d', tvt(o, 1):uint(), tvt(o + 1, 1):uint(), tvt(o + 2, 1):uint(), tvt(o + 3, 1):uint()) end
        tbl:add(f.pname, tvt(384, 12), string.format('network: %s / %s gw %s', ip(384), ip(388), ip(392)))
        if code == 0x11 then
          info = string.format('read parameters reply, S/N %d — table 1024 bytes', tvb(8, 4):le_uint())
        else
          info = string.format('write parameter table, S/N %d — %d byte(s) marked for update', tvb(12, 4):le_uint(), flagged or 0)
        end
      elseif ptype == 0x24 and code == 0x10 and len == 20 then
        info = string.format('read parameters request, to %s', tvb(12, 4):le_uint() == 0xffffffff and 'any controller' or tostring(tvb(12, 4):le_uint()))
      elseif ptype == 0x24 and code == 0x21 then
        info = string.format('write parameter table reply, S/N %d', tvb(8, 4):le_uint())
      end
    end
    pinfo.cols.info = info
    return len
  end

  local fc = tvb(1, 1):uint()
  local request = pinfo.dst_port == 60000
  local event = pinfo.dst_port == p.prefs.listener_port
  root:add(f.som, tvb(0, 1))
  root:add(f.func, tvb(1, 1))
  root:add_le(f.serial, tvb(4, 4))

  local name = FUNCTIONS[fc] or string.format('function 0x%02x', fc)
  local kind = event and 'event' or (request and 'request' or 'reply')
  local detail = ''
  if fc == 0x20 and not request then
    detail = status(tvb, root)
  elseif fc == 0xf2 and request then
    detail = write_parameters(tvb, root)
  elseif not request and fc ~= 0x20 then
    root:add(f.ok, tvb(8, 1))
  end
  pinfo.cols.info = string.format('%s %s, S/N %d%s', name, kind, tvb(4, 4):le_uint(), detail ~= '' and (' — ' .. detail) or '')
  return len
end

local udp = DissectorTable.get('udp.port')
local registered = 60001
udp:add(60000, p)
udp:add(registered, p)

function p.prefs_changed()
  if p.prefs.listener_port ~= registered then
    udp:remove(registered, p)
    registered = p.prefs.listener_port
    udp:add(registered, p)
  end
end
