import {readFileSync, writeFileSync, renameSync, existsSync} from 'node:fs';
import {randomInt, randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';

import {createServer} from 'node:http';

function startHealthServer(port) {
  const server = createServer((req, res) => {
    const healthy = req.url === '/health' && ['GET', 'HEAD'].includes(req.method);
    res.writeHead(healthy ? 204 : 404, {'Cache-Control': 'no-store'});
    res.end();
  });
  return server.listen(Number(port), '0.0.0.0');
}

const path = new URL('queue.json', import.meta.url);
const tmp = new URL('queue.tmp', import.meta.url);
let db = existsSync(path) ? JSON.parse(readFileSync(path,'utf8')) : {rooms:{}, profiles:{}, offset:0};
const tokenFile = new URL('.bot-token', import.meta.url);
let token = process.env.BOT_TOKEN?.trim() || (existsSync(tokenFile) ? readFileSync(tokenFile,'utf8').trim() : '');
async function askToken() {
  const {createInterface} = await import('node:readline/promises');
  const terminal = createInterface({input:process.stdin,output:process.stdout});
  try { return (await terminal.question('Вставьте токен от BotFather и нажмите Enter: ')).trim(); }
  finally { terminal.close(); }
}
function save() {
  writeFileSync(tmp, JSON.stringify(db));
  renameSync(tmp,path);
}
async function api(method, data={}) {
  const res = await fetch('https://api.telegram.org/bot'+token+'/'+method,{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data),
    signal:AbortSignal.timeout(60000)
  });
  const body = await res.json();
  if (!body.ok) {
    if (body.parameters?.retry_after) await sleep(body.parameters.retry_after*1000);
    throw Object.assign(Error(body.description),{code:body.error_code});
  }
  return body.result;
}
let me;
while (!me) {
  if (!token) token = await askToken();
  if (!/^\d+:[\w-]+$/.test(token)) {
    console.log('Проверьте формат токена.');
    token = '';
    continue;
  }
  try { me = await api('getMe'); }
  catch (error) {
    if (![401,404].includes(error.code)) throw error;
    console.log('Telegram отклонил токен.');
    token = '';
  }
}
if (token !== process.env.BOT_TOKEN) writeFileSync(tokenFile,token,{mode:0o600});
if (process.env.PORT) startHealthServer(process.env.PORT);
console.log('Бот работает: @'+me.username);
const clean = s => String(s || '').replace(/[\p{C}\s]+/gu,' ').trim().slice(0,100);
const help = 'В группе отправьте /open для записи и /close для жеребьёвки. Чтобы указать фамилию и имя, нажмите «Заполнить профиль».';
db.pending ??= {};
db.telegramNames ??= {};
function participantName(id, fallback) {
  const profile = db.profiles[id];
  const account = db.telegramNames[id] || fallback;
  if (!profile) return account;
  // Старый профиль хранился строкой «Имя Фамилия (ник)».
  const fullName = typeof profile === 'string'
    ? profile.replace(/ \(.*\)$/u,'').split(' ').reverse().join(' ')
    : profile.fullName;
  return fullName + ' (' + account + ')';
}
db.drafts ??= {};
db.subjects ??= {};
const prompts={subject:'Введите название предмета (до 80 символов).',time:'Введите время начала пары, например 18:20 или 18.20.',count:'Сколько преподавателей принимает защиту? Введите число от 1 до 10.'};
const days=['воскресенье','понедельник','вторник','среда','четверг','пятница','суббота'];
function parseDate(s) {
  const [day,month,year]=s.split('.').map(Number);
  return new Date(year,month-1,day,12);
}
function formatDate(date) {return date.toLocaleDateString('ru-RU',{day:'2-digit',month:'2-digit',year:'numeric'});}
function validDate(s) {return /^\d{2}\.\d{2}\.\d{4}$/.test(s) && formatDate(parseDate(s))===s;}
function weekday(s) {return parseDate(s).getDay();}
function summary(d) {
  const day=d.date ? days[weekday(d.date)] : days[d.weekday];
  const schedule=[d.date,day,d.time].filter(Boolean).join(' · ');
  return ['📚 '+(d.subject || 'Новый предмет'), '🗓 '+(schedule || 'Расписание не заполнено'),
    d.project?'Проектная защита':'Индивидуальная защита',
    'Преподаватели', ...(d.teachers?.length ? d.teachers.map(t=>'• '+t) : ['Пока не указаны'])].join('\n');
}
function button(d,text,verb,index,style) {
  return {text,callback_data:[verb,d.key,index].filter(v=>v!==undefined).join('/'),style};
}
db.privateChats ??= {};
function privateState(uid) {return db.privateChats[uid] ??= {};}
async function removePrivate(uid,id) {
  if(!id || id===privateState(uid).firstStart) return;
  try {await api('deleteMessage',{chat_id:uid,message_id:id});}
  catch(e){if(![400,403].includes(e.code)) throw e;}
}
async function panel(uid,text,rows=[],restore=false) {
  const state=privateState(uid);
  const history=state.history ??= [];
  if(!restore) {
    if(state.screen) history.push(state.screen);
    if(history.length>40) history.shift();
    state.screen=structuredClone({text,rows,draft:db.drafts[uid],pending:db.pending[uid]});
  }
  const links=[
    ...(history.length ? [[{text:'‹ Назад',callback_data:'nav/previous'}]] : []),
    [{text:'👤 Мои данные',callback_data:'nav/profile'},{text:'📚 Предметы',callback_data:'nav/subjects'}],
    [{text:'🏠 Главное меню',callback_data:'nav/home'}]
  ];
  const payload={chat_id:uid,text,reply_markup:{inline_keyboard:[...rows,...links]}};
  if(state.panel) {
    try {return await api('editMessageText',{...payload,message_id:state.panel});}
    catch(e){
      if(e.code===400 && /message is not modified/i.test(e.message)) return;
      if(e.code!==400 || !/message to edit not found|message can.t be edited|message_id_invalid/i.test(e.message)) throw e;
      await removePrivate(uid,state.panel);
    }
  }
  const sent=await api('sendMessage',payload);
  state.panel=sent.message_id;save();
  return sent;
}
function menu(d,text,rows) {return panel(d.uid,text,rows);}
function subjectsFor(d) {
  return {...db.subjects['personal-'+d.uid],...db.subjects[d.chat]};
}
function catalog(d) {
  const subjects=Object.values(subjectsFor(d));
  return menu(d,subjects.length?'📚 Выберите предмет':'📚 Расписание пока пусто',[
    ...subjects.map((t,i)=>[button(d,t.subject,'load',i)]),
    [button(d,'＋ Добавить предмет','add')]
  ]);
}
function groupSelected(d) {
  return Number(d.chat)<0 && (!d.editor || d.scopes?.includes(String(d.chat)));
}
function settings(d) {
  const groupName=db.organizers?.[d.uid]?.[d.chat] || d.chat;
  return menu(d,(groupSelected(d)?'👥 '+groupName+'\n':'')+summary(d),[
    [button(d,'✎ Название','subject'),button(d,'🗓 День недели','day')],
    [button(d,'◷ Время','time'),button(d,'🎓 Преподаватели','count')],
    [button(d,'Сменить тип защиты','mode')],
    ...(Number(d.chat)<0 ? [[button(d,d.auto?'⏰ '+days[d.auto.day]+' · '+d.auto.time+' · '+d.auto.hours+' ч':'⏰ Еженедельная запись','weekly')]] : []),
    [button(d,'Сохранить','save',undefined,'primary'),button(d,'‹ К списку','back')],
    ...(groupSelected(d) && d.auto ? [[button(d,'Отключить еженедельный набор','autoOff',undefined,'danger')]] : []),
    ...(groupSelected(d) ? [[button(d,'✓ Открыть запись','publish',undefined,'success')]] : [])
  ]);
}
const pad=n=>String(n).padStart(2,'0');
function rowsOf(items,width) {
  const rows=[];
  for (let i=0;i<items.length;i+=width) rows.push(items.slice(i,i+width));
  return rows;
}
function picker(d,text,rows,messageId) {
  return menu(d,text,rows);
}
function calendar(d,month,messageId) {
  const first=new Date(month*86400000);
  const year=first.getUTCFullYear(), n=first.getUTCMonth();
  const monthKey=delta=>Date.UTC(year,n+delta,1)/86400000;
  const title=first.toLocaleDateString('ru-RU',{year:'numeric',month:'long',timeZone:'UTC'});
  const cells=[];
  const blank=()=>button(d,'·','noop');
  for(let i=0;i<(first.getUTCDay()+6)%7;i++) cells.push(blank());
  const end=new Date(Date.UTC(year,n+1,0)).getUTCDate();
  for(let day=1;day<=end;day++) cells.push(button(d,String(day),'pick',pad(day)+'.'+pad(n+1)+'.'+year));
  while(cells.length%7) cells.push(blank());
  return picker(d,'🗓 Дата защиты\nВыберите день в календаре или отправьте день и месяц, например 25.11.',[
    [button(d,'‹','month',monthKey(-1)),button(d,title,'noop'),button(d,'›','month',monthKey(1))],
    ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].map(t=>button(d,t,'noop')),
    ...rowsOf(cells,7),[button(d,'Без даты · Пропустить','skip')]
  ],messageId);
}
function clockMenu(d,hour,messageId) {
  const minutes=hour!==undefined;
  const buttons=Array.from({length:minutes?60:24},(_,i)=>minutes
    ?button(d,pad(i),'settime',hour+':'+pad(i))
    :button(d,pad(i),'hour',pad(i)));
  const rows=rowsOf(buttons,minutes?8:6);
  if(minutes) rows.push([button(d,'‹ Выбрать другой час','time')]);
  return picker(d,minutes?'🕒 '+hour+':__  ·  Выберите минуты':'🕒 Начало пары  ·  Выберите час\nМожно также ввести время, например 18.20.',rows,messageId);
}
function shortDate(input) {
  const parts=/^(\d{1,2})\.(\d{1,2})$/.exec(input);
  if(!parts) return null;
  const now=new Date();
  const today=new Date(now.getFullYear(),now.getMonth(),now.getDate(),12);
  for(let year=now.getFullYear();year<=now.getFullYear()+8;year++) {
    const full=pad(parts[1])+'.'+pad(parts[2])+'.'+year;
    if(validDate(full) && parseDate(full)>=today) return full;
  }
  return null;
}
function saveSubject(d) {
  if (!d.subject || !d.time || !Number.isInteger(d.weekday) || !d.teachers?.length) return false;
  const subjects=db.subjects[d.chat] ??= {};
  d.subjectKey ??=randomUUID();
  subjects[d.subjectKey]={subject:d.subject,time:d.time,weekday:d.weekday,teachers:[...d.teachers],project:d.project,auto:d.auto};
  save();
  return true;
}
function joinMenu(d) {
  return {inline_keyboard:[...d.teachers.map((t,i)=>[{text:d.teachers.length===1?'Я защищаюсь':'Записаться к '+t,callback_data:'join/'+d.id+'/'+i}]),
    [{text:'Снять запись',callback_data:'leave/'+d.id},{text:'Заполнить профиль',url:'https://t.me/'+me.username+'?start=profile'}],[{text:'Закрыть запись и подвести итоги',style:'danger',callback_data:'stop/'+d.id}]]};
}
function shuffle(names) {
  for (let i=names.length-1;i>0;i--) {
    const j=randomInt(i+1);
    [names[i],names[j]]=[names[j],names[i]];
  }
}
async function handle(update) {
  let cb = update.callback_query;
  const msg = cb ? cb.message : update.message;
  if (!msg) return;
  const user = cb?.from ?? msg.from;
  if (!user) return;
  db.telegramNames[user.id] = clean([user.first_name,user.last_name].filter(Boolean).join(' ')) + (user.username?' @'+user.username:'');
  const chat = msg.chat.id;
  let room = db.rooms[chat];
  const send = (text,extra={}) => api('sendMessage',{chat_id:chat,text,...extra});
  const priv = msg.chat.type==='private';
  const uid = user.id;
  const personal = text=>panel(uid,text);
  let input = (msg.text || '').trim();
  if(priv && cb) {
    const state=privateState(uid);
    if(state.panel && state.panel!==msg.message_id) {
      await api('answerCallbackQuery',{callback_query_id:cb.id,text:'Используйте текущее меню.'});
      await removePrivate(uid,msg.message_id);return;
    }
    state.panel=msg.message_id;
    if(cb.data==='nav/previous') {
      await api('answerCallbackQuery',{callback_query_id:cb.id});
      const prev=state.history?.pop();
      if(!prev) return;
      state.screen=prev;db.drafts[uid]=structuredClone(prev.draft);db.pending[uid]=structuredClone(prev.pending);
      save();return panel(uid,prev.text,prev.rows,true);
    }
    const command={'nav/profile':'/register','nav/subjects':'/subjects','nav/home':'/start'}[cb.data];
    if(command) {
      await api('answerCallbackQuery',{callback_query_id:cb.id});
      input=command;cb=null;
    }
  }
  const [word,arg] = input.split(/\s+/);
  const [name,target] = word.split('@');
  const cmd=({'/queue':'/open','/draw':'/close'})[name] || name;
  if (!cb && target && target.toLowerCase()!==me.username.toLowerCase()) return;
  const draft = db.drafts[uid];
  async function publishQueue(date) {
      if (!groupSelected(draft)) return personal('Выберите группу в разделе «Предметы».');
      draft.date=date;
      const current=db.rooms[draft.chat];
      if (current && !current.result && current.id!==draft.key) return personal('В группе уже открыта запись. Сначала завершите её командой /close.');
      const next=current?.id===draft.key ? current : {...draft,id:draft.key,owner:uid,members:{},modern:true};
      db.rooms[draft.chat]=next;
      save();
      await announce(draft.chat,next);
      const failures=[];
      for (const id of [draft.command,draft.hint].filter(Boolean)) {
        try {await api('deleteMessage',{chat_id:draft.chat,message_id:id});}
        catch(e){if (![400,403].includes(e.code)) throw e; failures.push(id);}
      }
      delete db.drafts[uid];privateState(uid).history=[];delete privateState(uid).screen;save();
      return personal('Запись опубликована.'+(failures.includes(draft.command)?' Для удаления /open боту нужны права на удаление сообщений.':''));
  }
  const action = cb?.data || '';
  if (cb && priv) {
    const [verb,key,index] = action.split('/');
    if (!draft || key!==draft.key) return api('answerCallbackQuery',{callback_query_id:cb.id,text:'Это меню устарело.'});
    await api('answerCallbackQuery',{callback_query_id:cb.id});
    if (verb==='noop') return;
    if (verb==='scope' && draft.editor) {
      const scope=draft.scopes?.[Number(index)];
      if(!scope) return;
      draft.chat=scope;draft.key=randomUUID();save();return catalog(draft);
    }
    if (!groupSelected(draft) && ['publish','month','pick','skip'].includes(verb)) return;
    if (verb==='month' && draft.field==='eventDate') return calendar(draft,Number(index),msg.message_id);
    if (verb==='pick' && draft.field==='eventDate' && validDate(index)) return publishQueue(index);
    if (verb==='time' || (verb==='hour' && draft.field==='time')) {
      delete db.pending[uid];draft.field='time';save();return clockMenu(draft,verb==='hour'?index:undefined,verb==='hour'?msg.message_id:undefined);
    }
    if(verb==='settime' && draft.field==='time') {
      draft.time=index;delete draft.field;save();return settings(draft);
    }
    delete db.pending[uid];
    if (verb==='skip' && draft.field==='eventDate') return publishQueue(null);
    delete draft.field;
    if (verb==='back') return catalog(draft);
    if (verb==='add' || verb==='load') {
      const entry=Object.entries(subjectsFor(draft))[Number(index)];
      Object.assign(draft,{subject:'',subjectKey:null,auto:null,date:null,time:null,weekday:null,teachers:[],project:false});
      if (verb==='load' && entry) Object.assign(draft,entry[1],{subjectKey:entry[0]});
      draft.key=randomUUID();
      save();
      if (verb==='add') {draft.field='subject';save();return personal(prompts.subject);}
      return settings(draft);
    }
    if (verb==='day') return menu(draft,'Выберите день недели',[1,2,3,4,5,6,0].map(i=>[button(draft,days[i],'weekday',i)]));
    if (verb==='weekday' && /^[0-6]$/.test(index)) draft.weekday=Number(index);
    if (verb==='publish' || verb==='save') {
      if (!saveSubject(draft)) return personal('Укажите название, день недели, время и преподавателей.');
      if (verb==='save') return catalog(draft);
      draft.field='eventDate';save();
      const now=new Date();return calendar(draft,Date.UTC(now.getFullYear(),now.getMonth(),1)/86400000);
    }
    if(verb==='weekly' && Number(draft.chat)<0) return menu(draft,'⏰ Когда открывать запись каждую неделю? Время Екатеринбурга.',[
      ...rowsOf([1,2,3,4,5,6,0].map(i=>button(draft,days[i],'autoDay',i)),2),
      [button(draft,'Отключить расписание','autoOff')]
    ]);
    if(verb==='autoOff' && groupSelected(draft)) {
      const subject=db.subjects[draft.chat]?.[draft.subjectKey];
      if(subject) subject.auto=null;
      draft.auto=null;
      const state=privateState(uid);
      for(const screen of [...(state.history || []),state.screen]) {
        if(screen?.draft?.chat===draft.chat && screen.draft.subjectKey===draft.subjectKey) screen.draft.auto=null;
      }
      save();return settings(draft);
    }
    if(verb==='autoDay' && /^[0-6]$/.test(index) && Number(draft.chat)<0) {
      draft.autoDay=Number(index);draft.field='autoTime';save();return personal('Во сколько открывать запись? Например, 18.20 (Екатеринбург).');
    }
    if (verb==='mode') draft.project=!draft.project;
    if (Object.hasOwn(prompts,verb)) {
      draft.field=verb;save();return personal(prompts[verb]);
    }
    delete draft.field;save();return settings(draft);
  }
  if (cb) {
    const [verb,id,slot] = action.split('/');
    let answer='Запись уже закрыта.';
    if(verb==='stop' && room?.id===id && !room.result) {
      const allowed=uid===room.owner;
      await api('answerCallbackQuery',{callback_query_id:cb.id,text:allowed?'Запись закрыта.':'Завершить запись может организатор.'});
      if(allowed) return finish(chat,room);
      return;
    }
    if (room?.id===id && !room.result) {
      if (verb==='leave') {delete room.members[uid];answer='Ваша запись снята.';}
      if (verb==='join' && !room.modern) {room.members[uid]=db.telegramNames[uid];answer='Вы записаны.';}
      if (verb==='join' && room.modern && room.teachers[Number(slot)]) {
        const profile=db.profiles[uid];
        if (room.project && !profile?.group) answer='Сначала заполните профиль с номером группы и темой проекта.';
        else {
          const group=room.project ? profile.group : null;
          const others=Object.entries(room.members).filter(([id,m])=>id!==String(uid) && group && m.group===group);
          if (others.some(([,m])=>m.slot!==Number(slot))) answer='Ваша проектная группа уже выбрала другого преподавателя.';
          else {
            room.members[uid]={slot:Number(slot),group,topic:others[0]?.[1].topic || profile?.topic,name:db.telegramNames[uid]};
            answer=others.length?'Вы записаны вместе со своей проектной группой.':'Вы записаны на защиту.';
          }
        }
      }
      save();
    }
    return api('answerCallbackQuery',{callback_query_id:cb.id,text:answer,show_alert:true});
  }
  if (!priv && cmd==='/open') {
    if (msg.sender_chat) return send('Отправьте /open от своего личного аккаунта.');
    if (room && !room.result) return send('Запись уже открыта. Итоги — /close.');
    db.organizers ??= {}; (db.organizers[uid] ??= {})[chat]=msg.chat.title || String(chat);
    const d={key:randomUUID(),uid,chat,command:msg.message_id,project:false,teachers:['Преподаватель']};
    db.drafts[uid]=d;save();
    try {
      const state=privateState(uid);await removePrivate(uid,state.panel);delete state.panel;state.history=[];delete state.screen;save();
      return await catalog(d);}
    catch(e) {
      if (![400,403].includes(e.code)) throw e;
      const hint=await send('Организатор, откройте бота и нажмите «Старт» для настройки очереди.',{reply_markup:{inline_keyboard:[[{text:'Открыть бота',url:'https://t.me/'+me.username+'?start=q_'+d.key}]]}});
      d.hint=hint.message_id;save();return;
    }
  }
  if (priv && cmd==='/start' && arg?.startsWith('q_')) {
    if (draft && arg==='q_'+draft.key) return catalog(draft);
    return personal('Эта настройка доступна автору команды /open.');
  }
  if (priv && (cmd==='/subjects' || input==='📚 Редактировать предметы')) {
    const groups={...db.organizers?.[uid]};
    for(const [id,r] of Object.entries(db.rooms)) if(r.owner===uid) groups[id] ??=id;
    if(draft?.command && !draft.editor) groups[draft.chat] ??=String(draft.chat);
    const scopes=['personal-'+uid,...Object.keys(groups)];
    const d={uid,key:randomUUID(),editor:true,chat:scopes[0],scopes};
    db.drafts[uid]=d;delete db.pending[uid];save();
    if(scopes.length===1) return catalog(d);
    return menu(d,'📚 Редактор предметов\nВыберите личное расписание или группу.',scopes.map((id,i)=>[button(d,i===0?'Мои предметы':groups[id],'scope',i)]));
  }
  if (priv && (cmd==='/register' || input==='👤 Регистрация')) {
    db.pending[uid]={step:'name'};save();
    const profile=db.profiles[uid];
    const info=profile ? [participantName(uid,db.telegramNames[uid]),profile.group && 'Группа '+profile.group,profile.topic].filter(Boolean).join(' · ')+'\n\n' : '';
    return personal('👤 Мои данные\n'+info+'Напишите фамилию и имя одним сообщением.');
  }
  if (priv && (cmd==='/start' || cmd==='/help' || input==='🏠 Старт')) {
    delete db.pending[uid];if(draft) delete draft.field;save();
    return personal('🎓 Главное меню\n\n👤 Мои данные — изменить профиль для защиты.\n📚 Предметы — настроить расписание и преподавателей.');
  }
  if (priv && db.pending[uid] && !input.startsWith('/')) {
    const pending=db.pending[uid]===true ? (db.pending[uid]={step:'name'}) : db.pending[uid];
    if (pending.step==='name') {
      if (!/^\p{L}[\p{L}\p{M} ’'ʼ-]*\s+\p{L}[\p{L}\p{M} ’'ʼ-]*$/u.test(input) || input.length>100) return personal('Введите фамилию и имя через пробел.');
      pending.fullName=clean(input);pending.step='group';save();
      return personal('Введите номер проектной группы цифрами или «-», если не участвуете в проекте.');
    }
    if (pending.step==='group' && input!=='-') {
      if (!/^\d{1,12}$/.test(input)) return personal('Нужен номер группы цифрами, например 3.');
      pending.group=input.replace(/^0+(?=\d)/,'');pending.step='topic';save();
      return personal('Напишите название темы проекта.');
    }
    if (pending.step==='topic' && (!clean(input) || input.length>100)) return personal('Введите тему проекта до 100 символов.');
    db.profiles[uid]={fullName:pending.fullName,group:pending.group,topic:pending.group?clean(input):undefined};
    delete db.pending[uid];save();return personal('Профиль сохранён.');
  }
  if (priv && draft?.field && !input.startsWith('/')) {
    const f=draft.field;
    if (!clean(input)) return personal(prompts[f]);
    if(f==='autoTime') {
      if(!/^([01]?\d|2[0-3])[:.][0-5]\d$/.test(input)) return personal('Введите время, например 18:20.');
      draft.autoTime=input.replace('.',':').padStart(5,'0');draft.field='autoHours';save();
      return personal('Через сколько часов закрыть запись и опубликовать результат? Введите от 1 до 167.');
    }
    if(f==='autoHours') {
      const hours=Number(input);
      if(!Number.isInteger(hours)||hours<1||hours>167) return personal('Введите целое число часов от 1 до 167.');
      draft.auto={day:draft.autoDay,time:draft.autoTime,hours,owner:uid,since:Date.now()};
      delete draft.field;save();return settings(draft);
    }
    if (f==='eventDate') {
      const date=shortDate(input);
      if (!date) return personal('Выберите день в календаре или отправьте день и месяц, например 25.11.');
      return publishQueue(date);
    }
    if (f==='subject' && input.length<=80) draft.subject=clean(input);
    else if (f==='time' && /^([01]?\d|2[0-3])[:.][0-5]\d$/.test(input)) draft.time=input.replace('.',':').padStart(5,'0');
    else if (f==='count' && /^([1-9]|10)$/.test(input)) {
      draft.count=Number(input);draft.newTeachers=[];draft.field='teacher';save();
      return personal('Введите ФИО преподавателя 1 из '+draft.count+'.');
    } else if (f==='teacher') {
      const name=clean(input);
      if (input.length>80 || !name || draft.newTeachers.includes(name)) return personal('Введите отдельное ФИО до 80 символов без повторов.');
      draft.newTeachers.push(name);
      if (draft.newTeachers.length<draft.count) {
        save();return personal('Введите ФИО преподавателя '+(draft.newTeachers.length+1)+' из '+draft.count+'.');
      }
      draft.teachers=draft.newTeachers;delete draft.newTeachers;
    } else return personal(prompts[f] || 'Выберите поле в карточке предмета.');
    delete draft.field;save();return settings(draft);
  }
  if (priv) return personal('🎓 Главное меню\nВыберите профиль или предметы.');
  if (cmd==='/help' || cmd==='/register' || cmd==='/start') return send(help);
  if (cmd!=='/close' || priv) return;
  if (!room) return send('Сначала откройте запись командой /open.');
  if(!room.result && room.owner!==uid) return send('Завершить запись может организатор.');
  return finish(chat,room,Boolean(room.delivered));
}
async function finish(chat,room,repeat=false) {
  if(!room.result) {
    const members=Object.entries(room.members);
    const queues=room.modern ? room.teachers : ['Очередь на защиту'];
    room.result=queues.map((teacher,index)=>{
      const entries=new Map();
      for(const [id,m] of members) {
        if(room.modern && m.slot!==index) continue;
        entries.set(m.group ?? id,m.group?'Группа '+m.group+' — '+m.topic:participantName(id,m.name || m));
      }
      const names=[...entries.values()];shuffle(names);
      return [teacher,...(names.length?names.map((n,i)=>(i+1)+'. '+n):['Никто не записался'])].join('\n');
    });
    room.formatted=true;room.pendingResult=true;save();
  }
  const lines=room.modern || room.formatted ? room.result.join('\n\n').split('\n') : room.result.map((n,i)=>(i+1)+'. '+n);
  let page='🏁 Запись закрыта'+(room.subject?' · '+room.subject:'');
  const pages=[];
  for(const line of lines) {
    if(page.length+line.length>3900){pages.push(page);page='Продолжение очереди';}
    page+='\n'+line;
  }
  pages.push(page);
  for(let i=repeat?0:(room.sentPages || 0);i<pages.length;i++){
    await api('sendMessage',{chat_id:chat,text:pages[i]});
    if(!repeat){room.sentPages=i+1;save();}
  }
  if(room.post && !room.delivered) {
    try {await api('editMessageReplyMarkup',{chat_id:chat,message_id:room.post,reply_markup:{inline_keyboard:[]}});}
    catch(e){if(![400,403].includes(e.code)) throw e;}
  }
  room.delivered=true;room.pendingResult=false;save();
}
async function announce(chat,room) {
  if(room.post) return;
  const post=await api('sendMessage',{chat_id:chat,text:summary(room)+'\nВыберите, к кому записаться.',reply_markup:joinMenu(room)});
  room.post=post.message_id;save();
}
function weeklyStart(now,auto) {
  const local=new Date(now+5*3600000);
  const [hour,minute]=auto.time.split(':').map(Number);
  const daysAgo=(local.getUTCDay()-auto.day+7)%7;
  let start=Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),local.getUTCDate()-daysAgo,hour-5,minute);
  if(start>now) start-=7*86400000;
  return start;
}
async function tick(now=Date.now()) {
  for(const [chat,r] of Object.entries(db.rooms)) {
    if(r.pendingResult || (!r.result && r.closeAt<=now)) await finish(chat,r);
    else if(r.closeAt && !r.post && !r.result) await announce(chat,r);
  }
  for(const [chat,subjects] of Object.entries(db.subjects)) {
    if(!(Number(chat)<0)) continue;
    for(const [key,t] of Object.entries(subjects)) {
      const auto=t.auto;
      if(!auto) continue;
      const start=weeklyStart(now,auto), end=start+auto.hours*3600000;
      const runs=db.weeklyRuns ??= {};
      const slot=chat+'/'+key;
      if(start<auto.since || now>=end || runs[slot]===start) continue;
      if(db.rooms[chat] && !db.rooms[chat].result) continue;
      const room={...t,modern:true,id:randomUUID(),owner:auto.owner,members:{},closeAt:end};
      db.rooms[chat]=room;runs[slot]=start;save();
      await announce(chat,room);
    }
  }
}
try {
  await api('setMyCommands',{scope:{type:'all_group_chats'},commands:[
    {command:'open',description:'Открыть запись на защиту'},
    {command:'close',description:'Закрыть запись и показать результат'}
  ]});
} catch(e){console.error('Меню команд:',e.message);}
while (true) {
  try {
    try {await tick();} catch(e){console.error('Расписание:',e.message);}
    const updates = await api('getUpdates',{offset:db.offset,timeout:10,allowed_updates:['message','callback_query']});
    for (const update of updates) {
      try {
        const incoming=update.message;
        const privateMessage=incoming?.chat.type==='private';
        if(privateMessage && /^\/start(?:@\w+)?(?:\s|$)/i.test(incoming.text || '')) {
          privateState(incoming.chat.id).firstStart ??=incoming.message_id;
          save();
        }
        await handle(update);
        if(privateMessage) await removePrivate(incoming.chat.id,incoming.message_id);
      }
      catch (e) {if (![400,403].includes(e.code)) throw e; console.error(e.message);}
      db.offset=update.update_id+1;
      save();
    }
  } catch (e) {console.error(e.message);await sleep(3000);}
}





