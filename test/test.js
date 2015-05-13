var stream = require("stream");
var router = require("./../index")({
    "/my/**/*":"func:testFun",

    "index":"url:index.html",

    "test?v=*":"url:my*.html",

    "/public/bi*/**/*":"url:public/**/*"
});

router.on("notmatch" , function(){
    console.log('not match');
});

router.on("match" , function(path , requestpath){
    console.log("请求路径："+requestpath);
    console.log("==> "+path);
});

router.on("error" , function(err){
    console.log(err);
});

router.set("testFun" , function(req , res , requestpath){
    console.log("请求路径："+requestpath);
    console.log("执行 testFun");
});

describe("check" , function(){
    it("test1" , function(done){
        test("/public/biz009/stylesheets/css/man.css");
        done();
    });

    it("test2" , function(done){
        test("/my/1/2/3/4/abs.html?v=22");
        done();
    });

    it("test3" , function(done){
        test("/index");
        done();
    });

    it("test4" , function(done){
        test("/test?v=index");
        done();
    });
});

function test(url){
    var res = new stream.Writable();
    res.writeHead = function(){};
    res._write = function(chunk , enc , done){
        done();
    };

    var req = {
        url:url,
        headers:{
            'accept-encoding':''
        }
    };

    router.route(req , res);
}