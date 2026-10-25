(() => {
  "use strict";
  const $=id=>document.getElementById(id);
  const login=$("login"),dash=$("dashboard"),message=$("message"),list=$("grants");
  const storageKey="deskbeacon.manage.v1";
  let token=sessionStorage.getItem(storageKey)||"";
  let role="device",cursor=null;
  function notice(value){message.textContent=value;}
  function setView(){login.hidden=Boolean(token);dash.hidden=!token;}
  function stamp(value){if(!value)return "";const n=Number(value);return new Date(n<1e11?n*1000:n).toLocaleString();}
  async function api(path,options={}){
    const response=await fetch(path,{...options,cache:"no-store",headers:{"Authorization":"Bearer "+token,...options.headers}});
    if(response.status===401){token="";sessionStorage.removeItem(storageKey);setView();throw Error("认证已过期，请重新输入密钥");}
    const data=await response.json();
    if(!response.ok)throw Error(data.error||"请求失败");
    return data;
  }
  async function load(more=false){
    if(!token)return;
    if(!more){cursor=null;list.replaceChildren();}
    notice("正在获取授权记录…");
    const params=new URLSearchParams({role});
    if(more&&cursor)params.set("cursor",cursor);
    try{
      const result=await api("/manage/api/grants?"+params);
      for(const grant of result.items){
        const box=document.createElement("article");
        const heading=document.createElement("strong");heading.textContent=grant.label||grant.clientId;
        const meta=document.createElement("p");
        meta.textContent=(role==="device"?(grant.online?"在线 · ":"离线 · "):"")+
          grant.clientId+" · 授权 "+stamp(grant.createdAt);
        const revoke=document.createElement("button");
        revoke.type="button";revoke.className="secondary";
        revoke.textContent="撤销授权";
        revoke.addEventListener("click",async()=>{
          if(!confirm("确定撤销“"+(grant.label||grant.clientId)+"”的授权？撤销后需要重新授权。"))return;
          revoke.disabled=true;
          try{await api("/manage/api/grants/"+encodeURIComponent(grant.id),{method:"DELETE"});await load();}
          catch(e){notice(e.message);revoke.disabled=false;}
        });
        box.append(heading,meta,revoke);list.append(box);
      }
      cursor=result.cursor;$("next-wrap").hidden=!cursor;
      notice(result.items.length?"已加载 "+result.items.length+" 条记录":"没有更多已授权的 "+role+"。");
    }catch(e){notice(e.message);}
  }
  $("login-form").addEventListener("submit",async event=>{
    event.preventDefault();
    const form=event.currentTarget,values=new FormData(form);
    const proof=values.get("cap-token");
    if(typeof proof!=="string"||!proof){notice("请先完成验证");return;}
    notice("正在验证管理员身份…");
    try{
      const response=await fetch("/manage/token",{
        method:"POST",headers:{"content-type":"application/json"},
        body:JSON.stringify({secret:values.get("secret"),capToken:proof})
      });
      const data=await response.json();
      if(!response.ok)throw Error(data.error==="invalid_credentials"?"管理员密钥不正确":data.error||"验证失败");
      token=data.token;
      sessionStorage.setItem(storageKey,token);
      form.reset();
      setView();await load();
    }catch(e){notice(e.message);$("admin-cap").reset();}
  });
  $("refresh").addEventListener("click",()=>load());
  $("load-more").addEventListener("click",()=>load(true));
  $("tab-agents").addEventListener("click",()=>{role="agent";load();});
  $("tab-devices").addEventListener("click",()=>{role="device";load();});
  $("logout").addEventListener("click",()=>{token="";sessionStorage.removeItem(storageKey);setView();list.replaceChildren();notice("已退出管理页面");});
  setView();if(token)load();
})();
