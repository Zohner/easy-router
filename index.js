"use strict";

var http = require("http");
var fs = require("fs");
var url = require("url");
var events = require("events");
var util = require("util");
var path = require("path");
var zlib = require("zlib");
var mimes = require("./mimes");
var crypto = require("crypto");
var stream = require("stream");
var querystring = require("querystring");

var ALL_FOLDER_REG = /(?:\/|^)\*\*\//g;
var ALL_FOLDER_REG_STR = '/(?:[\\w\\u4e00-\\u9fa5._-]*\/)*';
var ALL_FILES_REG = /\*+/g;
var ALL_FILES_REG_STR = '[\\w\\u4e00-\\u9fa5._-]+';
var noop = function () {};
var cache = {};

var FUN_NAME = "easy_router_function_";
var SEQ = 1000000;

function Router(){}

//继承事件类
util.inherits(Router, events.EventEmitter);

var rp = Router.prototype;

rp.constructor = Router;

//路由初始化
rp.init = function(options){
    this.inited = true;
    this.methods = {};
    this.maps = {};
    this.filters = [];//存放根据key转化的正则
    this.address = [];//存放相应的地址

    var defaults = {
        useZlib:true,
        useCache:false,     //如果设为true，则使用http缓存
        maxCacheSize:0.5      //凡是小于maxCacheSize的资源将以文件内容的md5值作为Etag，单位为MB
    };

    for (var key in defaults) {
        this[key] = (isObject(options) && (key in options)) ? options[key] : defaults[key];
    }

    return this;
};

//如果调用listen方法，则直接启动服务
rp.listen = function(port){
    var that = this;
    var server = http.createServer(function(req , res){
        that.route(req , res);
    }).listen(port);

    console.log("服务启动，监听"+port+"端口中...");

    return server;
};

//处理路由映射表
rp.handleMaps = function (maps) {
    var that = this;
    maps = maps || this.maps;

    var ad;

    each(maps , function(map , k){
        if (isString(map)) {
            map = map.trim();

            if (map.indexOf(":") >= 0) {
                ad = map.split(':', 2);
            } else {
                ad = ['url', map];
            }

            if (ad[0] === "url") {
                ad[1] = ad[1].replace(ALL_FOLDER_REG, '__A__').replace(ALL_FILES_REG, '__B__');
            }
        } else if (isFunction(map)) {
            ad = ["func", FUN_NAME + SEQ];
            that.methods[FUN_NAME + SEQ] = map;
            SEQ++;
        } else {
            return;
        }

        each(k.split(",") , function(f){
            f = f.trim();
            f = f.charAt(0) == "/" ? f : ("/" + f);
            f = f.replace(/\?/g, "\\?");

            var fil = f.replace(ALL_FOLDER_REG, '__A__').replace(ALL_FILES_REG, '__B__');
            var re = new RegExp("^" + fil.replace(/__A__/g, ALL_FOLDER_REG_STR).replace(/__B__/g, ALL_FILES_REG_STR) + "$");

            that.filters.push([fil , re]);
            that.address.push(ad);
        })
    })
};

//添加设置路由映射表
rp.setMap = function(maps){
    if(!this.inited) this.init();

    if(isObject(maps) && !isArray(maps)){
        for(var k in maps){
            this.maps[k] = maps[k];
        }
    }else if(isString(maps) && arguments.length == 2){
        this.maps[maps] = arguments[1];
        var key = maps;
        maps = {};
        maps[key] = arguments[1]
    }else {
        return;
    }

    this.handleMaps(maps);

    return this;
};

//设置方法
rp.set = function (name, func) {
    if (!name)return;

    this.methods[name] = (func instanceof Function) ? func : noop;
};

//路由引导方法，放在http.createServer(function(req , res){router.route(req , res)})
rp.route = function (req, res) {
    if(!this.inited) this.init();

    var urlobj = url.parse(req.url);

    var i = 0;
    var fil , ads , pathname;
    req.params = urlobj.search ? querystring.parse(urlobj.query) : {};

    for (; i < this.filters.length; i++) {
        fil = this.filters[i];
        ads = this.address[i];

        if (!fil[1].test(pathname = decodeURI(fil[0].indexOf("?") >= 0 ? urlobj.path : urlobj.pathname))) continue;

        if(ads[0] === "url"){
            //如果是url则查找相应url的文件
            var filepath = getpath(fil[0] , ads[1] , pathname);

            this.emit("path" , filepath , pathname);
            if(this.routeTo(req , res , filepath)){
                this.emit("match", filepath , pathname);
                return;
            }
        }else if(ads[0] === "func" && (ads[1] in this.methods)){
            //如果是func则执行保存在methods里的方法
            var args = Array.prototype.slice.call(arguments , 0);
            args.splice(2 , 0 , pathname);
            this.methods[ads[1]].apply(this , args);
            return;
        }
    }

    this.emit("notmatch");

    this.error(res);
};

//根据路径引导路由至相应文件
rp.routeTo = function(req , res , filepath , headers){
    var that = this;
    var accept = req.headers['accept-encoding'];
    var etag,times;

    if(!fs.existsSync(filepath)) return false;

    var stats = fs.statSync(filepath);

    if(!stats.isFile()) return false;

    var fileKind = filepath.substring((filepath.lastIndexOf(".")+1)||0 , filepath.length).toLowerCase();
    var source = fs.createReadStream(filepath);

    var index = mimes.indexOf('.'+fileKind);
    var options = {
        'Content-Type': mimes[index+1]+';charset=utf-8',
        'X-Power-By':'Easy-Router'
    };

    each(headers , function(value , k){
        options[k] = value;
    });

    //如果为资源文件则使用http缓存
    if(that.useCache && /^(?:js|css|png|jpg|gif)$/.test(fileKind)){
        options['Cache-Control'] = 'max-age=' + (365 * 24 * 60 * 60 * 1000);
        times = String(stats.mtime).replace(/\([^\x00-\xff]+\)/g , "").trim();

        //先判断文件更改时间
        if (req.headers['if-modified-since'] == times) {
            that.cache(res);
            return true;
        }

        //如果文件小于一定值，则直接将文件内容的md5值作为etag值
        var hash = crypto.createHash("md5");
        if (~~(stats.size / 1024 / 1024) <= +that.maxCacheSize) {
            etag = '"' + stats.size + '-' + hash.update(fs.readFileSync(filepath)).digest("hex").substring(0, 10) + '"';
        } else {
            etag = 'W/"' + stats.size + '-' + hash.update(times).digest("hex").substring(0, 10) + '"';
        }

        //如果文件更改时间发生了变化，再判断etag
        if(req.headers['if-none-match'] === etag){
            that.cache(res);
            return true;
        }

        options['ETag'] = etag;
        options['Last-Modified'] = times;
    }else {
        options['Cache-Control'] = 'no-cache';
    }

    //如果为文本文件则使用zlib压缩
    if(that.useZlib && /^(?:js|css|html)$/.test(fileKind)){
        if(/\bgzip\b/g.test(accept)){
            options['Content-Encoding'] = 'gzip';
            res.writeHead(200, options);

            source.pipe(zlib.createGzip()).pipe(res);
            return true;
        }else if(/\bdeflate\b/g.test(accept)){
            options['Content-Encoding'] = 'deflate';
            res.writeHead(200, options);
            source.pipe(zlib.createDeflate()).pipe(res);
            return true;
        }
    }

    res.writeHead(200, options);
    source.pipe(res);

    return true;
};

//404错误
var motions = ["(๑¯ิε ¯ิ๑)" , "(●′ω`●)" , "=皿=!" , "(ง •̀_•́)ง┻━┻" , "┑(￣Д ￣)┍" , "覀L覀"];
rp.error = function(res){
    res.writeHead(404 , {'content-type':'text/html;charset=utf-8'});
    res.end('<div style="text-align: center;font: 20px \'微软雅黑\';line-height: 100px;color: red;">404 Not Found&nbsp;&nbsp;&nbsp;'+motions[Math.floor(Math.random()*motions.length)]+'</div>');
};

//304缓存
rp.cache = function(res){
    res.writeHead(304);
    res.end();
};

//该方法是根据路由规则，转换请求路径为文件路径
function getpath(fil, ads, pathname) {
    var filepath = ads,
        index = 0,
        collector = [];

    var reg = /__(?:A|B)__/g;
    if (reg.test(fil) && !(reg.lastIndex = 0) && reg.test(ads)) {
//        将__转成逗号，方便转成数组
        fil = fil.replace(reg , function(m){return m.replace(/__/g , ",")});
        ads = ads.replace(reg , function(m){return m.replace(/__/g , ",")});
        var filArray = fil.split(",") , adsArray = ads.split(",");

        //先将不需要匹配的字符过滤掉
        each(filArray , function(f){
            if (!f) return;

            if (isAB(f)) {
                collector.push(f);
            } else {
                pathname = pathname.replace(new RegExp(f), '');
            }
        });

        //再根据正则拆分路径
        each(collector , function(c){
            var reg = new RegExp(c === 'A' ? ALL_FOLDER_REG_STR : ALL_FILES_REG_STR);

            //扫描路径，当遇到AB关键字时处理，如果两者不相等，停下adsArray的扫描，继续执行对filArray的扫描，直至遇到相等数值
            while (index < adsArray.length) {
                if (isAB(adsArray[index])) {
                    if (adsArray[index] === c) {
                        adsArray[index] = pathname.match(reg)[0];
                        index++;
                    }
                    break;
                }
                index++;
            }

            pathname = pathname.replace(reg, '');
        });

        filepath = adsArray.join("");
    }

    filepath = path.normalize(filepath);
    filepath = filepath.charAt(0) == path.sep ? filepath.substring(1, filepath.length) : filepath;

    return filepath;
}

//判断是否为A或B
function isAB(msg){
    return /^(?:A|B)$/.test(msg);
}

function isObject(obj){
    return !!obj && typeof obj === 'object';
}

function isArray(obj){
    return toString.call(obj) === "[object Array]";
}

function isString(msg){
    return typeof msg === "string" || false;
}

function isFunction(func){
    return typeof func === "function" || false;
}

//遍历方法
function each(arg , callback){
    if(!(typeof arg == "object"))return;

    if(arg instanceof Array){
        arg.forEach(callback);
    }else {
        for(var k in arg){
            callback(arg[k] , k);
        }
    }
}

var router = new Router();

module.exports = router;