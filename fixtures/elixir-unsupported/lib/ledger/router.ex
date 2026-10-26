defmodule Ledger.Router do
  use Plug.Router

  plug :match
  plug :dispatch

  get "/balances/:account" do
    send_resp(conn, 200, Ledger.Accounts.balance(account) |> to_string())
  end
end
