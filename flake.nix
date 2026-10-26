{
  description = "ShitBot - Twitter monitoring bot with Discord/Telegram/OneBot integration";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            bun
            nodejs_24
            git
            sqlite
            jq
            stdenv.cc.cc.lib
          ];

          shellHook = ''
            export LD_LIBRARY_PATH="${pkgs.stdenv.cc.cc.lib}/lib:$LD_LIBRARY_PATH"
            # 代理配置（可选，取消注释并设置地址）
            # export HTTPS_PROXY="http://127.0.0.1:7890"
            # export HTTP_PROXY="http://127.0.0.1:7890"

            # 调试模式（跳过 WebUI 密码验证）
            export DEBUG_MODE="true"

            # Twitter 认证（二选一）
            # 方式一：Cookie 认证
            # export TWITTER_AUTH_TOKEN=""
            # export TWITTER_CT0=""
            # 方式二：账号密码登录（需配合 TOTP）
            # export TWITTER_USERNAME=""
            # export TWITTER_PASSWORD=""
            # export TWITTER_EMAIL=""
            # export TWITTER_TOTP_SECRET=""

            # 平台 Bot Token
            # export DISCORD_TOKEN=""
            # export TELEGRAM_TOKEN=""

            # OneBot11 (QQ)
            # export ONEBOT_URL="ws://127.0.0.1:8080"
            # export ONEBOT_TOKEN=""
            # export ONEBOT_SECRET=""

            # x-to-img 截图服务（可选）
            # export X_TO_IMAGE_API_URL=""
            # export X_TO_IMAGE_API_TOKEN=""
            # export X_TO_IMAGE_API_THEME="light"

            echo "ShitBot devShell 已加载"
          '';
        };
      }
    );
}
