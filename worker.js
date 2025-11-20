const config = {
  result_page: false,      // 是否使用结果页展示最终长链，而不是直接 302 跳转
  theme: "",               // 首页主题，默认空。urlcool 主题写 "theme/urlcool"
  cors: true,              // 是否允许跨域（API 用）
  unique_link: false,      // 同一个长链接是否复用同一个短链
  custom_link: true,       // 是否允许用户自定义短链 key
  overwrite_kv: false,     // 是否允许覆盖已有的 KV key
  snapchat_mode: false,    // 阅后即焚模式（访问后删除）
  visit_count: false,      // 是否记录访问次数
  load_kv: true,          // 是否允许通过 qryall 加载全部 KV
  system_type: "shorturl", // "shorturl" / "imghost" / 其他 {pastebin, journal}
}

// 在 UI 和 API 中受保护的 key，不能被读/写/删
const protect_keylist = [
  "password",
]

let index_html = "https://Rupan3sei.github.io/shorturl-ui/index.html"
let result_html = "https://Rupan3sei.github.io/shorturl-ui/result.html"

const html404 = `<!DOCTYPE html>
<html>
  <body>
    <h1>404 Not Found.</h1>
    <p>The url you visit is not found.</p>
    <p><a href="https://github.com/crazypeace/Url-Shorten-Worker/" target="_self">Fork me on GitHub</a></p>
  </body>
</html>`

// 基础 Header（主要是 CORS），Content-Type 按需单独指定
let base_header = {}
if (config.cors) {
  base_header = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  }
}

function jsonHeader() {
  return {
    ...base_header,
    "Content-Type": "application/json; charset=UTF-8",
  }
}

function htmlHeader() {
  return {
    ...base_header,
    "Content-Type": "text/html; charset=UTF-8",
  }
}

function base64ToBlob(base64String) {
  const parts = base64String.split(";base64,")
  const contentType = parts[0].split(":")[1]
  const raw = atob(parts[1])
  const rawLength = raw.length
  const uInt8Array = new Uint8Array(rawLength)
  for (let i = 0; i < rawLength; ++i) {
    uInt8Array[i] = raw.charCodeAt(i)
  }
  return new Blob([uInt8Array], { type: contentType })
}

async function randomString(len) {
  len = len || 6
  const chars = "ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678" // 去掉易混淆字符
  const maxPos = chars.length
  let result = ""
  for (let i = 0; i < len; i++) {
    result += chars.charAt(Math.floor(Math.random() * maxPos))
  }
  return result
}

async function sha512(url) {
  const encoded = new TextEncoder().encode(url)
  const url_digest = await crypto.subtle.digest(
    {
      name: "SHA-512",
    },
    encoded
  )
  const hashArray = Array.from(new Uint8Array(url_digest))
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("")
  return hashHex
}

async function checkURL(URL) {
  const str = URL
  const Expression = /http(s)?:\/\/([\w-]+\.)+[\w-]+(\/[\w-.\/?%&=]*)?/
  const objExp = new RegExp(Expression)
  if (objExp.test(str) === true) {
    if (str[0] === "h") return true
    return false
  }
  return false
}

// 生成一个随机 key 并保存 URL（保证不和现有 key 冲突）
async function save_url(URL) {
  const random_key = await randomString()
  const is_exist = await LINKS.get(random_key)
  if (is_exist == null) {
    await LINKS.put(random_key, URL)
    return random_key
  }
  // 冲突就重新生成
  return await save_url(URL)
}

// 判断某个 key 是否存在（这里原来是用来存 url_sha512 → short_key）
async function is_key_exist(key) {
  const is_exist = await LINKS.get(key)
  if (is_exist == null) {
    return false
  }
  return is_exist
}

async function handleRequest(request) {
  // 从 KV 中读取 password
  const password_value = await LINKS.get("password")

  // 把真实控制台路径也加入保护名单（不能被 add/del/qry 到）
  if (password_value && !protect_keylist.includes(password_value)) {
    protect_keylist.push(password_value)
  }

  /************************
   * 以下是 API 处理（POST）
   ************************/
  if (request.method === "POST") {
    let req
    try {
      req = await request.json()
    } catch (e) {
      return new Response(
        `{"status":500,"key":"","error":"Error: Invalid JSON body."}`,
        { headers: jsonHeader() }
      )
    }

    const req_cmd = req["cmd"]
    const req_url = req["url"]
    const req_key = req["key"]
    const req_password = req["password"]

    // 密码验证
    if (req_password !== password_value) {
      return new Response(
        `{"status":500,"key":"","error":"Error: Invalid password."}`,
        { headers: jsonHeader() }
      )
    }

    // 新增短链
    if (req_cmd === "add") {
      if (config.system_type === "shorturl" && !(await checkURL(req_url))) {
        return new Response(
          `{"status":500,"url":"${req_url}","error":"Error: Url illegal."}`,
          { headers: jsonHeader() }
        )
      }

      try {
        let random_key = ""

        // 1. 用户自定义短链
        if (config.custom_link && req_key && req_key !== "") {
          // 保护 key 不允许被用作自定义短链
          if (protect_keylist.includes(req_key)) {
            return new Response(
              `{"status":500,"key":"${req_key}","error":"Error: Key in protect_keylist."}`,
              { headers: jsonHeader() }
            )
          }

          const exist_value = await LINKS.get(req_key)
          if (!config.overwrite_kv && exist_value != null) {
            return new Response(
              `{"status":500,"key":"${req_key}","error":"Error: Specific key existed."}`,
              { headers: jsonHeader() }
            )
          }

          random_key = req_key
          await LINKS.put(req_key, req_url)
        }
        // 2. unique_link 模式（同 URL 复用同一短链）
        else if (config.unique_link) {
          const url_sha512 = await sha512(req_url)
          const url_key = await is_key_exist(url_sha512)

          if (url_key) {
            // url_sha512 -> short_key 已存在
            random_key = url_key
          } else {
            random_key = await save_url(req_url)
            await LINKS.put(url_sha512, random_key)
          }
        }
        // 3. 普通随机短链
        else {
          random_key = await save_url(req_url)
        }

        return new Response(
          `{"status":200,"key":"${random_key}","error":""}`,
          { headers: jsonHeader() }
        )
      } catch (e) {
        return new Response(
          `{"status":500,"key":"","error":"Error: Reach the KV write limitation."}`,
          { headers: jsonHeader() }
        )
      }

      // 删除短链
    } else if (req_cmd === "del") {
      if (protect_keylist.includes(req_key)) {
        return new Response(
          `{"status":500,"key":"${req_key}","error":"Error: Key in protect_keylist."}`,
          { headers: jsonHeader() }
        )
      }

      await LINKS.delete(req_key)

      if (config.visit_count) {
        await LINKS.delete(req_key + "-count")
      }

      return new Response(
        `{"status":200,"key":"${req_key}","error":""}`,
        { headers: jsonHeader() }
      )

      // 查询某个 key 对应的 URL
    } else if (req_cmd === "qry") {
      if (protect_keylist.includes(req_key)) {
        return new Response(
          `{"status":500,"key":"${req_key}","error":"Error: Key in protect_keylist."}`,
          { headers: jsonHeader() }
        )
      }

      const value = await LINKS.get(req_key)
      if (value != null) {
        const jsonObjectReturn = {
          status: 200,
          error: "",
          key: req_key,
          url: value,
        }
        return new Response(JSON.stringify(jsonObjectReturn), {
          headers: jsonHeader(),
        })
      }
      return new Response(
        `{"status":500,"key":"${req_key}","error":"Error: Key not exist."}`,
        { headers: jsonHeader() }
      )

      // 查询全部 KV（需要 config.load_kv = true）
    } else if (req_cmd === "qryall") {
      if (!config.load_kv) {
        return new Response(
          `{"status":500,"error":"Error: Config.load_kv false."}`,
          { headers: jsonHeader() }
        )
      }

      const keyList = await LINKS.list()
      if (keyList != null) {
        const jsonObjectReturn = {
          status: 200,
          error: "",
          kvlist: [],
        }

        for (let i = 0; i < keyList.keys.length; i++) {
          const item = keyList.keys[i]

          // 隐藏 password / 控制台路径
          if (protect_keylist.includes(item.name)) {
            continue
          }
          // 隐藏访问计数 KV
          if (item.name.endsWith("-count")) {
            continue
          }

          const url = await LINKS.get(item.name)
          const newElement = { key: item.name, value: url }
          jsonObjectReturn.kvlist.push(newElement)
        }

        return new Response(JSON.stringify(jsonObjectReturn), {
          headers: jsonHeader(),
        })
      }

      return new Response(
        `{"status":500,"error":"Error: Load keyList failed."}`,
        { headers: jsonHeader() }
      )
    }

    // 未知 cmd
    return new Response(
      `{"status":500,"key":"","error":"Error: Invalid cmd."}`,
      { headers: jsonHeader() }
    )
  }

  // 处理 CORS 预检
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: base_header,
    })
  }

  /************************
   * 浏览器直接访问 Worker
   ************************/
  const requestURL = new URL(request.url)
  let path = requestURL.pathname.split("/")[1]
  path = decodeURIComponent(path)
  const params = requestURL.search

  // 访问根路径：直接重定向到百度（你可以改成自己主页）
  if (!path) {
    return Response.redirect("https://baidu.com", 302)
  }

  // 如果 path 等于 password_value，则返回管理页面 index.html
  if (path === password_value) {
    let index = await fetch(index_html)
    index = await index.text()
    index = index.replace(/__PASSWORD__/gm, password_value)
    return new Response(index, {
      headers: htmlHeader(),
    })
  }

  // 查询短链对应的 value
  let value = await LINKS.get(path)

  // 避免直接把 password key 读出来
  if (protect_keylist.includes(path)) {
    value = ""
  }

  if (!value) {
    return new Response(html404, {
      headers: htmlHeader(),
      status: 404,
    })
  }

  // 访问计数功能
  if (config.visit_count) {
    let count = await LINKS.get(path + "-count")
    if (count === null) {
      await LINKS.put(path + "-count", "1")
    } else {
      const next = parseInt(count, 10)
      await LINKS.put(path + "-count", (Number.isNaN(next) ? 1 : next + 1).toString())
    }
  }

  // 阅后即焚：访问一次后删除记录
  if (config.snapchat_mode) {
    await LINKS.delete(path)
  }

  // 带上 query 参数
  if (params) {
    value = value + params
  }

  // 如果启用了自定义结果页
  if (config.result_page) {
    let result_page_html = await fetch(result_html)
    let result_page_html_text = await result_page_html.text()
    result_page_html_text = result_page_html_text.replace(/{__FINAL_LINK__}/gm, value)
    return new Response(result_page_html_text, {
      headers: htmlHeader(),
    })
  }

  // 没有结果页，根据 system_type 不同做不同处理
  if (config.system_type === "shorturl") {
    // 短链：302 跳转
    return Response.redirect(value, 302)
  }
  if (config.system_type === "imghost") {
    // 图床：返回图片二进制
    const blob = base64ToBlob(value)
    return new Response(blob)
  }

  // 其他类型：直接把 value 显示出来（纯 KV/pastebin 等）
  return new Response(value, {
    headers: htmlHeader(),
  })
}

addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event.request))
})
