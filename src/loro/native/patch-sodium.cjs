// Apply to this project's version-checked react-native-libsodium dependency.
const fs=require('node:fs'),path=require('node:path');
const dir=process.argv[2];
if(!dir)throw Error('dependency directory required');
const pkg=JSON.parse(fs.readFileSync(path.join(dir,'package.json'),'utf8'));
if(pkg.version!=='1.7.0')throw Error('unsupported libsodium binding');
const file=path.join(dir,'cpp/react-native-libsodium.cpp');
const original=fs.readFileSync(file,'utf8');
let s=original;
const anchor='        auto jsi_crypto_box_keypair = jsi::Function::createFromHostFunction(';
const marker='jsi_cc_crypto_scalarmult_base';
if(!s.includes(marker)){if(s.split(anchor).length!==2)throw Error('unexpected native binding');const code=`        // Creative Cooking adapter: derive an X25519 public key inside libsodium.
        auto jsi_cc_crypto_scalarmult_base = jsi::Function::createFromHostFunction(
            jsiRuntime, jsi::PropNameID::forUtf8(jsiRuntime, "jsi_cc_crypto_scalarmult_base"), 1,
            [](jsi::Runtime &runtime, const jsi::Value &, const jsi::Value *arguments, size_t count) -> jsi::Value {
                if (count != 1) throw jsi::JSError(runtime, "invalid scalar");
                std::string name = "scalar";
                validateIsArrayBuffer("crypto_scalarmult_base", runtime, arguments[0], name, true);
                auto scalar = arguments[0].asObject(runtime).getArrayBuffer(runtime);
                if (scalar.size(runtime) != crypto_scalarmult_SCALARBYTES) throw jsi::JSError(runtime, "invalid scalar length");
                std::vector<uint8_t> output(crypto_scalarmult_BYTES);
                if (crypto_scalarmult_base(output.data(), scalar.data(runtime)) != 0) throw jsi::JSError(runtime, "scalar multiplication failed");
                return arrayBufferAsObject(runtime, output);
            });
        jsiRuntime.global().setProperty(jsiRuntime, "jsi_cc_crypto_scalarmult_base", std::move(jsi_cc_crypto_scalarmult_base));

`;s=s.replace(anchor,code+anchor)}

const pointMarker='jsi_cc_crypto_scalarmult';
if(!s.includes(`"${pointMarker}"`)){
 if(s.split(anchor).length!==2)throw Error('unexpected native binding');
 const code=`        // Use libsodium for X25519 point validation and equivalence checks.
        auto jsi_cc_crypto_scalarmult = jsi::Function::createFromHostFunction(
            jsiRuntime, jsi::PropNameID::forUtf8(jsiRuntime, "jsi_cc_crypto_scalarmult"), 2,
            [](jsi::Runtime &runtime, const jsi::Value &, const jsi::Value *arguments, size_t count) -> jsi::Value {
                if (count != 2) throw jsi::JSError(runtime, "invalid X25519 arguments");
                std::string scalarName = "scalar", pointName = "point";
                validateIsArrayBuffer("crypto_scalarmult", runtime, arguments[0], scalarName, true);
                validateIsArrayBuffer("crypto_scalarmult", runtime, arguments[1], pointName, true);
                auto scalar = arguments[0].asObject(runtime).getArrayBuffer(runtime);
                auto point = arguments[1].asObject(runtime).getArrayBuffer(runtime);
                if (scalar.size(runtime) != crypto_scalarmult_SCALARBYTES || point.size(runtime) != crypto_scalarmult_BYTES)
                    throw jsi::JSError(runtime, "invalid X25519 length");
                std::vector<uint8_t> output(crypto_scalarmult_BYTES);
                if (crypto_scalarmult(output.data(), scalar.data(runtime), point.data(runtime)) != 0)
                    throw jsi::JSError(runtime, "X25519 rejected the point");
                return arrayBufferAsObject(runtime, output);
            });
        jsiRuntime.global().setProperty(jsiRuntime, "jsi_cc_crypto_scalarmult", std::move(jsi_cc_crypto_scalarmult));

`;
 s=s.replace(anchor,code+anchor);
}

// The pinned helper calls the runtime's replaceable ArrayBuffer constructor.
// Check the actual allocation before copying any native result into it.
const copy='        memcpy(arraybuffer.data(runtime), data.data(), data.size());';
const check='        if (arraybuffer.size(runtime) != data.size()) throw jsi::JSError(runtime, "invalid output buffer length");';
const checkedCopy=`${check}\n${copy}`;
if(!s.includes(checkedCopy)){
 if(s.split(copy).length!==2)throw Error('unexpected native output buffer helper');
 s=s.replace(copy,checkedCopy);
}
if(s!==original)fs.writeFileSync(file,s);
