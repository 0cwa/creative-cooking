// Apply to this project's version-checked react-native-libsodium dependency.
const fs=require('node:fs'),path=require('node:path');const dir=process.argv[2];if(!dir)throw Error('dependency directory required');const pkg=JSON.parse(fs.readFileSync(path.join(dir,'package.json'),'utf8'));if(pkg.version!=='1.7.0')throw Error('unsupported libsodium binding');const file=path.join(dir,'cpp/react-native-libsodium.cpp');let s=fs.readFileSync(file,'utf8');const anchor='        auto jsi_crypto_box_keypair = jsi::Function::createFromHostFunction(';const marker='jsi_cc_crypto_scalarmult_base';if(!s.includes(marker)){if(s.split(anchor).length!==2)throw Error('unexpected native binding');const code=`        // Creative Cooking adapter: derive an X25519 public key inside libsodium.
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

`;s=s.replace(anchor,code+anchor);fs.writeFileSync(file,s)}
