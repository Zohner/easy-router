"use strict";
var fs = require("fs");
var url = require("url");
var events = require("events");
var util = require("util");
var path = require("path");
var zlib = require("zlib");
var mimes = require("./mimes");
var crypto = require("crypto");
var stream = require("stream");

var ALL_FOLDER_REG = /(\/|^)\*\*\//g;
var ALL_FOLDER_REG_STR = '/([\\w._-]*\/)*';
var ALL_FILES_REG = /\*+/g;
var ALL_FILES_REG_STR = '[\\w._-]+';
var noop = function () {};
var cache = {};
var router = null;

var FUN_NAME = "easy_router_function_";
var SEQ = 1000000;

var Router = function (arg , options) {
    this.methods = {};
    var defaults = {
        useZlib:true,
        useCache:true,
        maxCacheSize:0.5      //凡是小于maxCacheSize的资源将以文件内容的md5值作为Etag，单位为MB
    };

    if ((typeof arg == "object") && !(arg instanceof Array)) {
        this.maps = arg;
    } else if (typeof arg == "string") {
        try {
            var json = fs.readFileSync(arg).toString();
            this.maps = eval('(' + json + ')');
        } catch (e) {
            console.log(e);
            this.maps = {};
        }
    } else {
        this.maps = {};
    }

    for (var key in defaults) {
        this[key] = ((typeof options == "object") && (key in options)) ? options[key] : defaults[key];
    }

    this.handleMaps();
};

//继承事件类
util.inherits(Router, events.EventEmitter);

var rp = Router.prototype;

rp.constructor = Router;

rp.handleMaps = function (map) {
    map = map || this.maps;
    this.filters = this.filters || [];  //存放根据key转化的正则
    this.address = this.address || [];  //存放相应的地址

    for (var k in map) {
        var fil = k.trim();

        fil = fil.charAt(0) == "/" ? fil : ("/" + fil);
        fil = fil.replace(/\?/g , "\\?").replace(ALL_FOLDER_REG, '__A__').replace(ALL_FILES_REG, '__B__');

        var kind = typeof map[k];
        if(kind == "string"){
            var ad = map[k].trim().split(':' , 2);

            if(ad[0]==="url"){
                ad[1] = ad[1].replace(ALL_FOLDER_REG, '__A__').replace(ALL_FILES_REG, '__B__');
            }
        }else if(kind == "function"){
            ad = ["func", FUN_NAME + SEQ];
            this.methods[FUN_NAME + SEQ] = map[k];
            SEQ++;
        }

        if(fil && ad){
            this.filters.push(fil);
            this.address.push(ad);
        }
    }
};

rp.setMap = function(maps){
    for(var k in maps){
        this.maps[k] = maps[k];
    }

    this.handleMaps(maps);
};

rp.set = function (name, func) {
    if (!name)return;

    this.methods[name] = (func instanceof Function) ? func : noop;
};

rp.route = function (req, res) {
    var urlobj = url.parse(req.url);

    var i = 0;
    var fil , ads , pathname;

    for (; i < this.filters.length; i++) {
        fil = this.filters[i];
        ads = this.address[i];

        var reg = new RegExp("^" + fil.replace(/__A__/g, ALL_FOLDER_REG_STR).replace(/__B__/g, ALL_FILES_REG_STR) + "$");

        if (reg.test(pathname = (fil.indexOf("?") >= 0 ? urlobj.path : urlobj.pathname))) {
            if(ads[0] === "url"){
                //如果是url则查找相应url的文件
                var filepath = getpath(fil , ads[1] , pathname);
                this.emit("path" , filepath , pathname);
                if(this.routeTo(req , res , filepath)){
                    this.emit("match", filepath , pathname);
                    return;
                }
            }else if(ads[0] === "func" && (ads[1] in this.methods)){
                //如果是func则执行保存在methods里的方法
                var args = [];
                for(var i=0;i<=arguments.length;i++){
                    if(i==2){
                        args.push(pathname)
                    }
                    args.push(arguments[i])
                }
                this.methods[ads[1]].apply(this , args);

                return;
            }
        }
    }

    this.emit("notmatch");

    this.error(res);
};

rp.routeTo = function(req , res , filepath , headers){
    var that = this;
    var accept = req.headers['accept-encoding'];
    var etag,times;

    if(!fs.existsSync(filepath)) return false;

    var stats = fs.statSync(filepath);

    if(!stats.isFile()) return false;

    var fileKind = filepath.substring((filepath.lastIndexOf(".")+1)||0 , filepath.length);
    var source = fs.createReadStream(filepath);

    var index = mimes.indexOf('.'+fileKind);
    var options = {
        'Content-Type': mimes[index+1]+';charset=utf-8',
        'X-Power-By':'Easy-Router'
    };

    for(var k in headers){
        options[k] = headers[k];
    }

    //如果为资源文件则使用http缓存
    if(that.useCache && /^(js|css|png|jpg|gif)$/.test(fileKind)){
        options['Cache-Control'] = 'max-age=' + (365 * 24 * 60 * 60 * 1000);
        times = String(stats.mtime).replace(/\([^\x00-\xff]+\)/g , "").trim();

        //先判断文件更改时间
        if(req.headers['if-modified-since']==times){
            that.cache(res);
            return true;
        }

        //如果文件小于一定值，则直接将文件内容的md5值作为etag值
        var hash = crypto.createHash("md5");
        if(~~(stats.size/1024/1024) <= +that.maxCacheSize){
            etag = '"'+stats.size+'-'+hash.update(fs.readFileSync(filepath)).digest("hex").substring(0,10)+'"';
        }else {
            etag = 'W/"'+stats.size+'-'+hash.update(times).digest("hex").substring(0,10)+'"';
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
    if(that.useZlib && /^(js|css|html)$/.test(fileKind)){
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

var motions = ["(๑¯ิε ¯ิ๑)" , "(●′ω`●)" , "=皿=!" , "(ง •̀_•́)ง┻━┻" , "┑(￣Д ￣)┍" , "覀L覀"];
rp.error = function(res){
    res.writeHead(404 , {'content-type':'text/html;charset=utf-8'});
    res.end('<div style="text-align: center;font: 20px \'微软雅黑\';line-height: 100px;color: red;">404 Not Found&nbsp;&nbsp;&nbsp;'+motions[Math.floor(Math.random()*motions.length)]+'</div>');
};

rp.cache = function(res){
    res.writeHead(304);
    res.end();
};

//该方法是根据路由规则，转换请求路径为文件路径
function getpath(fil, ads, pathname) {
    var filepath = ads;
    var collector = [];
    if (/__(A|B)__/g.test(fil) && /__(A|B)__/g.test(ads)) {
        var filArray = fil.split("__");
        var adsArray = ads.split("__");

        var index = 0;

        //先将不需要匹配的字符过滤掉
        for (var k = 0; k < filArray.length; k++) {
            if (!filArray[k]) continue;

            if (filArray[k] === 'A' || filArray[k] === 'B') {
                collector.push(filArray[k])
            } else {
                pathname = pathname.replace(new RegExp(filArray[k]), '');
            }
        }

        //再根据正则拆分路径
        collector.forEach(function (element) {
            var reg = new RegExp(element === 'A' ? ALL_FOLDER_REG_STR : ALL_FILES_REG_STR);

            //扫描路径，当遇到AB关键字时处理，如果两者不相等，停下adsArray的扫描，继续执行对filArray的扫描，直至遇到相等数值
            while (index < adsArray.length) {
                if (adsArray[index] === 'A' || adsArray[index] === 'B') {
                    if (adsArray[index] === element) {
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

module.exports = function (arg , options) {
    router = router || new Router(arg , options);
    return router;
};