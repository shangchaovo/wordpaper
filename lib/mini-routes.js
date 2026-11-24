'use strict';

const {randomBytes} = require('node:crypto');
const {failure} = require('./ai-model');

function createMiniRoutes(options) {
  const {storage, learning, voices, sentence, mini, devtools, allowDevRequest, desktopSession, requireCsrf, readJson, json, mirroring, upstream, clientIp} = options;
  const desktopPath='/api/account/mini';
  async function desktop(req,res,path) {
    const session=desktopSession(req,res);
    if(!session)return;
    if(!['GET','POST','DELETE'].includes(req.method))throw failure('method','请求方式无效',405);
    if(req.method!=='GET' && !requireCsrf(req,res,session))return;
    if(mirroring()){
      if(session.user.id!==upstream.localUserId())throw failure('account_changed','请重新登录同步账号',403);
      if(path===desktopPath+'/speech' && req.method==='POST'){
        const config=storage.speech.get(session.user.id);
        if(!config)throw failure('speech_missing','本机账号尚未设置 AI 语音。',409);
        const peer=upstream.pairedInfo();
        if(!peer?.url?.startsWith('https://'))throw failure('https_required','请先连接 HTTPS 云账号服务，再同步语音配置。',409);
        const response=await upstream.modelRequest('PUT','/api/account/speech',config);
        return json(res,response.status,response.status===200?{ok:true}:response.json||{error:'云端尚未支持账号语音。'});
      }
      if(path!==desktopPath)throw failure('missing','未找到',404);
      const result=await upstream.modelRequest(req.method,desktopPath,req.method==='GET'?undefined:{});
      return json(res,result.status,result.json||{error:'请更新云端账号服务后重试。'});
    }
    if(path!==desktopPath)throw failure('missing','未找到',404);
    if(!mini.config().loginAvailable&&!devtools)throw failure('mini_unavailable','账号服务器尚未配置微信小程序。',503);
    const id=session.user.id;
    if(req.method==='POST')return json(res,201,mini.createPairCode(id));
    if(req.method==='DELETE')return json(res,200,mini.unlink(id));
    return json(res,200,mini.binding(id));
  }
  async function route(req,res,parsed) {
    const path=parsed.pathname, method=req.method;
    try {
      if(path===desktopPath||path.startsWith(desktopPath+'/'))return await desktop(req,res,path);
      if(mirroring())throw failure('authority_required','请使用 WordPaper 主账号服务器连接小程序。',409);
      const action=path.slice('/api/mini/'.length);
      if(action==='config'&&method==='GET') return json(res,200,mini.config());
      if(action==='devtools/login' && method==='POST'){
        if(!devtools || !allowDevRequest(req))throw failure('not_found','未找到',404);
        const body=await readJson(req);
        const secret=body.deviceSecret || randomBytes(32).toString('hex');
        const result=mini.loginDevtools(secret,clientIp(req));
        return json(res,200,{...result,...(!body.deviceSecret?{deviceSecret:secret}:{})});
      }
      if(devtools && !allowDevRequest(req))throw failure('not_found','未找到',404);
      if(method==='POST'&&['login','pair/preview','pair/confirm'].includes(action)){
        const body=await readJson(req);let result;
        if(action==='login')result=await mini.login(body.code,clientIp(req));
        if(action==='pair/preview')result=mini.previewPair(body.loginTicket,body.code,clientIp(req));
        if(action==='pair/confirm')result=mini.confirmPair(body.confirmationToken);
        return json(res,200,result);
      }
      const match=/^Bearer ([a-zA-Z0-9_-]+)$/.exec(req.headers.authorization || '');
      if(!match)throw failure('login_required','请先配对 WordPaper 账号。',401);
      const session=mini.authenticate(match[1]);
      const id=session.userId, query=Object.fromEntries(parsed.searchParams);
      const authorize=()=>mini.authenticate(match[1]);
      const access={authorize, sessionId:session.sessionId};
      let body;
      if (method==='POST' || method==='PUT') {
        body=await readJson(req);
        authorize();
      }
      async function replyToCurrentSession(work) {
        const value=await work;
        authorize();
        return json(res,200,value);
      }
      switch(method+' '+action){
        case 'GET binding':return json(res,200,mini.binding(id));
        case 'DELETE binding':return json(res,200,mini.unlink(id,authorize));
        case 'GET catalog':return json(res,200,learning.catalog(id,query));
        case 'GET word':{
          const word=learning.word(id,query.id);
          if(!word)throw failure('word_missing','词条已变更。',404);
          return json(res,200,word);
        }
        case 'GET snapshot':return json(res,200,learning.snapshot(id,query));
        case 'POST event':{
          const value=learning.mutate(id,body,authorize);
          mini.afterLearning(id);
          return json(res,200,value);
        }
        case 'POST sentence':return await replyToCurrentSession(sentence.submit(id,body,access));
        case 'PUT goal':return json(res,200,learning.goal(id,body,authorize));
        case 'GET reminder':return json(res,200,mini.reminder(id));
        case 'POST reminder': {
          const result = body?.enableOnly === true
            ? mini.setReminderEnabled(id, true, body.timezone, authorize)
            : mini.reserveReminder(id, body, authorize);
          return json(res, 200, result);
        }
        case 'DELETE reminder':return json(res,200,mini.cancelReminder(id,authorize));
        case 'GET voice':return await replyToCurrentSession(voices.settings(id));
        case 'PUT voice':return await replyToCurrentSession(voices.set(id,body,access));
        case 'POST example':return await replyToCurrentSession(voices.example(id,body.id,access));
        case 'GET audio':{
          const audio=await voices.audio(id,query.id,query.part||'word',access);
          mini.authenticate(match[1]);
          res.writeHead(200,{'Content-Type':audio.type,'Content-Length':audio.buffer.length,'Cache-Control':'private, no-store'});
          return res.end(audio.buffer);
        }
        default:throw failure('not_found','未找到小程序接口',404);
      }
    }catch(err){
      if(!err.status) console.error('[mini] request failed:',err.code || err.name);
      return json(res,err.status||503,{error:err.status?err.message:'账号服务暂时不可用。',code:err.status?err.code:'mini_unavailable'});
    }
  }
  return route;
}
module.exports={createMiniRoutes};
